#!/usr/bin/env python3
"""Bounded host executor for backup-privacy service cutover.

This is the first layer that may mutate Docker services. It consumes the signed
plan/baseline/journal/preflight/runtime-attestation chain and never operates on
services outside the signed mutable set.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

MUTABLE = ("export-cleanup", "retention-scan", "app")
PRESERVED = ("libsql", "caddy")
ALL_SERVICES = (*MUTABLE, *PRESERVED)
TARGET = {
    "PRIVACY_BACKUP_STATE": "ENABLED",
    "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
}


class HostCutoverError(RuntimeError):
    pass


class HostCutoverBlocked(RuntimeError):
    pass


def fail(code: str, message: str) -> "NoReturn":
    raise HostCutoverError(f"{code}: {message}")


def blocked(code: str, message: str) -> "NoReturn":
    raise HostCutoverBlocked(f"{code}: {message}")


def load_module(path: Path, name: str):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("HOST_CUTOVER_MODULE_UNSAFE", f"{name} must be an absolute regular file")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        fail("HOST_CUTOVER_MODULE_INVALID", f"could not load {name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_private(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or not path.parent.is_dir():
        fail("HOST_CUTOVER_EVIDENCE_DIR_UNSAFE", "evidence directory is unsafe")
    os.chmod(path.parent, 0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
        parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def run(command: list[str], *, check: bool = False) -> subprocess.CompletedProcess[bytes]:
    proc = subprocess.run(command, check=False, capture_output=True)
    if check and proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", errors="replace")[-500:]
        fail("HOST_CUTOVER_COMMAND_FAILED", f"command exited {proc.returncode}: {detail}")
    return proc


def run_json(command: list[str], code: str) -> dict[str, Any]:
    proc = run(command)
    try:
        value = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HostCutoverError(f"{code}_OUTPUT_INVALID: command did not return JSON") from exc
    if not isinstance(value, dict):
        fail(f"{code}_OUTPUT_INVALID", "command output must be a JSON object")
    if proc.returncode != 0 or value.get("status") == "BLOCKED":
        fail(code, str(value.get("blocker") or value.get("status") or proc.returncode))
    return value


class HostCutover:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        root = Path(__file__).resolve().parents[2]
        self.root = root
        self.execution_tool = root / "infra/backup/backup-privacy-service-cutover-execution.py"
        self.preflight_tool = root / "infra/backup/backup-privacy-service-cutover-preflight.py"
        self.runtime_attester = root / "infra/backup/backup-privacy-service-live-runtime-attestation.py"
        self.baseline_checker = root / "infra/backup/check-backup-privacy-service-live-baseline.py"
        self.cutover_plan_checker = root / "infra/backup/check-backup-privacy-service-cutover-plan-v2.py"
        self.handoff_checker = root / "infra/backup/check-backup-privacy-target-handoff.py"
        self.volume_resolver = root / "infra/backup/resolve-active-club-volumes.py"
        self.activation_executor_path = root / "infra/backup/execute-backup-privacy-activation.py"
        self.activation_plan_checker = root / "infra/backup/check-backup-privacy-activation-plan.py"
        self.runtime_checker = root / "infra/backup/check-backup-privacy-runtime.sh"
        self.core = load_module(self.execution_tool, "backup_privacy_host_execution_core")
        self.activation = load_module(self.activation_executor_path, "backup_privacy_host_activation_executor")
        self.key = self.core.read_key(args.key_file)
        self.plan_env = self.core.verify_plan(args.cutover_plan, self.key)
        self.plan = self.plan_env["record"]
        self.baseline_env = self.core.verify_baseline(args.baseline, self.key, args.cutover_plan, self.plan)
        self.baseline = self.baseline_env["record"]
        self.env_file = Path(self.plan["envFilePath"])
        self.compose_file = Path(self.plan["composeFilePath"])
        self.activation_plan = Path(self.plan["activationPlanPath"])
        self.pending = Path(self.plan["pendingEvidencePath"])
        self.handoff = Path(self.plan["targetHandoffPath"])
        self.project = self.baseline["composeProjectName"]
        self.evidence_root = args.evidence_root
        self.execution_root = args.execution_root
        self.baseline_verification = self.evidence_root / "baseline-verification.json"
        self.preflight_result = self.evidence_root / "preflight" / "privacy-check.json"
        self.preflight_proof = self.evidence_root / "preflight" / "preflight-proof.json"
        self.target_attestation = self.evidence_root / "runtime" / "target-attestation.json"
        self.rollback_attestation = self.evidence_root / "runtime" / "rollback-attestation.json"
        self.inspect_counter = 0
        self.journal = self.execution_root / self.plan["cutoverId"] / "service-cutover-execution-pending.json"
        self.target_config_checker = self._target_config_checker()
        self._verify_static_bindings()

    def _target_config_checker(self) -> Path:
        envelope = self.core.read_envelope(self.handoff, "TARGET_HANDOFF")
        value = envelope["record"].get("targetConfigCheckerPath")
        if not isinstance(value, str):
            fail("HOST_CUTOVER_TARGET_CONFIG_CHECKER_MISSING", "target handoff does not bind target-config checker")
        return Path(value)

    def _verify_static_bindings(self) -> None:
        if self.plan.get("recreateServices") != ["app", "export-cleanup", "retention-scan"]:
            fail("HOST_CUTOVER_MUTABLE_SET_INVALID", "signed recreate set differs from bounded host policy")
        if self.plan.get("preserveServices") != ["libsql", "caddy"]:
            fail("HOST_CUTOVER_PRESERVE_SET_INVALID", "signed preserve set differs from bounded host policy")
        if self.plan.get("preflightService") != "privacy-check" or self.plan.get("preflightMustSucceedBeforeMutation") is not True:
            fail("HOST_CUTOVER_PREFLIGHT_POLICY_INVALID", "signed plan lacks required privacy-check preflight")
        if self.plan.get("rollbackOnCutoverFailureRequired") is not True:
            fail("HOST_CUTOVER_ROLLBACK_POLICY_INVALID", "signed plan does not require rollback")
        for path, code in ((self.env_file, "ENV_FILE"), (self.compose_file, "COMPOSE_FILE"), (self.activation_plan, "ACTIVATION_PLAN")):
            self.core.read_file(path, code, private=code != "COMPOSE_FILE")
        compose_sha = self.core.sha256_bytes(self.core.read_file(self.compose_file, "COMPOSE_FILE"))
        if compose_sha != self.plan.get("composeFileSha256"):
            fail("HOST_CUTOVER_COMPOSE_FILE_DRIFT", "compose file differs from signed plan")
        if str(self.args.cutover_plan) != str(Path(self.args.cutover_plan).resolve()):
            fail("HOST_CUTOVER_PLAN_PATH_NOT_ABSOLUTE", "cutover plan path must be absolute")
        self.evidence_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.execution_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.evidence_root, 0o700)
        os.chmod(self.execution_root, 0o700)

    def docker(self, *parts: str, check: bool = False) -> subprocess.CompletedProcess[bytes]:
        return run(["docker", *parts], check=check)

    def compose(self, *parts: str, check: bool = False) -> subprocess.CompletedProcess[bytes]:
        return self.docker("compose", "--env-file", str(self.env_file), "-f", str(self.compose_file), *parts, check=check)

    def verify_target_render(self) -> None:
        raw_env = self.core.read_file(self.env_file, "ENV_FILE", private=True)
        if self.core.sha256_bytes(raw_env) != self.plan.get("targetEnvFingerprint"):
            fail("HOST_CUTOVER_TARGET_ENV_DRIFT", "target env fingerprint differs from signed plan")
        proc = self.compose("config", "--format", "json")
        if proc.returncode != 0:
            fail("HOST_CUTOVER_COMPOSE_RENDER_FAILED", proc.stderr.decode("utf-8", errors="replace")[-500:])
        try:
            rendered = json.loads(proc.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HostCutoverError("HOST_CUTOVER_COMPOSE_RENDER_INVALID: compose config did not return JSON") from exc
        digest = self.core.sha256_bytes((canonical_json(rendered) + "\n").encode("utf-8"))
        if digest != self.plan.get("renderedComposeSha256"):
            fail("HOST_CUTOVER_COMPOSE_RENDER_DRIFT", "rendered target compose differs from signed plan")

    def collect_inspect(self, label: str) -> dict[str, Path]:
        self.inspect_counter += 1
        directory = self.evidence_root / "inspect" / f"{self.inspect_counter:04d}-{label}"
        directory.mkdir(parents=True, exist_ok=False, mode=0o700)
        os.chmod(directory, 0o700)
        result: dict[str, Path] = {}
        for service in ALL_SERVICES:
            proc = self.docker(
                "ps", "-a", "--no-trunc",
                "--filter", f"label=com.docker.compose.project={self.project}",
                "--filter", f"label=com.docker.compose.service={service}",
                "--format", "{{.ID}}",
            )
            if proc.returncode != 0:
                fail("HOST_CUTOVER_DOCKER_PS_FAILED", proc.stderr.decode("utf-8", errors="replace")[-300:])
            ids = [line.strip() for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
            if len(ids) != 1:
                fail("HOST_CUTOVER_CONTAINER_CARDINALITY", f"{service} resolved {len(ids)} containers")
            inspect = self.docker("inspect", ids[0])
            if inspect.returncode != 0:
                fail("HOST_CUTOVER_DOCKER_INSPECT_FAILED", f"docker inspect failed for {service}")
            path = directory / f"{service}.json"
            write_private(path, inspect.stdout)
            result[service] = path
        return result

    def execution_common(self, inspect: dict[str, Path]) -> list[str]:
        return [
            "--cutover-plan", str(self.args.cutover_plan),
            "--baseline", str(self.args.baseline),
            "--baseline-verification", str(self.baseline_verification),
            "--key-file", str(self.args.key_file),
            "--app-inspect", str(inspect["app"]),
            "--export-inspect", str(inspect["export-cleanup"]),
            "--retention-inspect", str(inspect["retention-scan"]),
            "--libsql-inspect", str(inspect["libsql"]),
            "--caddy-inspect", str(inspect["caddy"]),
        ]

    def assess(self, inspect: dict[str, Path]) -> dict[str, Any]:
        return run_json(
            [sys.executable, str(self.execution_tool), "assess", *self.execution_common(inspect), "--journal", str(self.journal)],
            "HOST_CUTOVER_EXECUTION_ASSESSMENT_FAILED",
        )

    def event(self, phase: str, inspect: dict[str, Path], attestation: Path | None = None) -> dict[str, Any]:
        command = [
            sys.executable, str(self.execution_tool), "event", *self.execution_common(inspect),
            "--journal", str(self.journal), "--phase", phase,
        ]
        if attestation is not None:
            command.extend(["--attestation", str(attestation)])
        return run_json(command, f"HOST_CUTOVER_EVENT_{phase}_FAILED")

    def refresh_baseline_verification(self) -> None:
        command = [
            sys.executable, str(self.baseline_checker),
            "--cutover-plan-checker", str(self.cutover_plan_checker),
            "--handoff-checker", str(self.handoff_checker),
            "--target-config-checker", str(self.target_config_checker),
            "--activation-plan", str(self.activation_plan),
            "--pending", str(self.pending),
            "--handoff", str(self.handoff),
            "--key-file", str(self.args.key_file),
            "--env-file", str(self.env_file),
            "--compose-file", str(self.compose_file),
            "--cutover-plan", str(self.args.cutover_plan),
            "--baseline", str(self.args.baseline),
            "--volume-resolver", str(self.volume_resolver),
        ]
        proc = run(command)
        write_private(self.baseline_verification, proc.stdout)
        try:
            result = json.loads(proc.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HostCutoverError("HOST_CUTOVER_BASELINE_VERIFICATION_INVALID: checker output is not JSON") from exc
        if proc.returncode != 0 or result.get("status") != "SERVICE_LIVE_BASELINE_VERIFIED" or result.get("serviceCutoverExecutionAllowed") is not True:
            fail("HOST_CUTOVER_BASELINE_NOT_VERIFIED", str(result.get("blocker") or result.get("status")))

    def ensure_journal_started(self, inspect: dict[str, Path]) -> dict[str, Any]:
        if not self.journal.exists():
            self.refresh_baseline_verification()
            prepared = run_json(
                [
                    sys.executable, str(self.execution_tool), "prepare", *self.execution_common(inspect),
                    "--execution-root", str(self.execution_root),
                ],
                "HOST_CUTOVER_JOURNAL_PREPARE_FAILED",
            )
            if Path(prepared["journalPath"]) != self.journal:
                fail("HOST_CUTOVER_JOURNAL_PATH_MISMATCH", "execution core returned unexpected journal path")
        elif not self.baseline_verification.exists():
            blocked("HOST_CUTOVER_BASELINE_VERIFICATION_MISSING", "existing journal has no bound baseline-verification file")
        current = self.assess(inspect)
        if current["status"] == "READY_TO_START":
            self.event("CUTOVER_STARTED", inspect)
            current = self.assess(inspect)
        return current

    def preflight_static_args(self) -> list[str]:
        return [
            "--execution-core", str(self.execution_tool),
            "--cutover-plan", str(self.args.cutover_plan),
            "--baseline", str(self.args.baseline),
            "--baseline-verification", str(self.baseline_verification),
            "--journal", str(self.journal),
            "--key-file", str(self.args.key_file),
            "--preflight-result", str(self.preflight_result),
        ]

    def preflight_live_args(self, inspect: dict[str, Path]) -> list[str]:
        return [
            "--app-inspect", str(inspect["app"]),
            "--export-inspect", str(inspect["export-cleanup"]),
            "--retention-inspect", str(inspect["retention-scan"]),
            "--libsql-inspect", str(inspect["libsql"]),
            "--caddy-inspect", str(inspect["caddy"]),
        ]

    def ensure_preflight_proof(self, inspect: dict[str, Path], assessment: dict[str, Any]) -> None:
        if self.preflight_proof.exists():
            run_json(
                [sys.executable, str(self.preflight_tool), "check", *self.preflight_static_args(), "--proof", str(self.preflight_proof)],
                "HOST_CUTOVER_PREFLIGHT_PROOF_INVALID",
            )
            return
        if assessment.get("status") != "READY_TO_RECREATE_TARGET" or assessment.get("liveState") != "BASELINE":
            blocked("HOST_CUTOVER_PREFLIGHT_PROOF_MISSING_AFTER_MUTATION", "cannot mint missing preflight proof after runtime mutation")
        proc = self.compose("run", "--rm", "--no-deps", "-T", "privacy-check")
        write_private(self.preflight_result, proc.stdout)
        if proc.returncode != 0:
            fail("HOST_CUTOVER_PREFLIGHT_COMMAND_FAILED", proc.stderr.decode("utf-8", errors="replace")[-500:])
        run_json(
            [
                sys.executable, str(self.preflight_tool), "prepare", *self.preflight_static_args(),
                *self.preflight_live_args(inspect), "--output", str(self.preflight_proof),
            ],
            "HOST_CUTOVER_PREFLIGHT_PROOF_PREPARE_FAILED",
        )
        run_json(
            [sys.executable, str(self.preflight_tool), "check", *self.preflight_static_args(), "--proof", str(self.preflight_proof)],
            "HOST_CUTOVER_PREFLIGHT_PROOF_INVALID",
        )

    def full_privacy_environment(self, inspect_path: Path) -> dict[str, str]:
        raw = self.core.read_file(inspect_path, "HOST_CUTOVER_INSPECT")
        parsed = json.loads(raw)
        if not isinstance(parsed, list) or len(parsed) != 1 or not isinstance(parsed[0], dict):
            fail("HOST_CUTOVER_INSPECT_INVALID", "inspect evidence is invalid")
        config = parsed[0].get("Config")
        raw_env = config.get("Env") if isinstance(config, dict) else None
        if not isinstance(raw_env, list):
            fail("HOST_CUTOVER_INSPECT_ENV_INVALID", "inspect environment is invalid")
        values: dict[str, str] = {}
        for item in raw_env:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                if key.startswith("PRIVACY_BACKUP_") or key.startswith("PRIVACY_NOTIFICATIONS_"):
                    values[key] = value
        return values

    def service_privacy_state(self, service: str, inspect: dict[str, Path]) -> str:
        live = self.core.read_inspect(inspect[service], service)
        state = self.core.service_state(live)
        full = self.full_privacy_environment(inspect[service])
        if full.get("PRIVACY_NOTIFICATIONS_STATE") != "DISABLED":
            return "UNKNOWN"
        return state

    def wait_service(self, service: str, timeout: int = 90) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            proc = self.docker(
                "ps", "-a", "--no-trunc",
                "--filter", f"label=com.docker.compose.project={self.project}",
                "--filter", f"label=com.docker.compose.service={service}",
                "--format", "{{.ID}}",
            )
            ids = [line.strip() for line in proc.stdout.decode("utf-8").splitlines() if line.strip()] if proc.returncode == 0 else []
            if len(ids) == 1:
                inspected = self.docker("inspect", ids[0])
                if inspected.returncode == 0:
                    try:
                        item = json.loads(inspected.stdout.decode("utf-8"))[0]
                    except Exception:  # noqa: BLE001
                        item = {}
                    state = item.get("State") if isinstance(item, dict) else None
                    if isinstance(state, dict) and state.get("Status") == "running":
                        if service != "app":
                            return
                        health = state.get("Health")
                        if isinstance(health, dict) and health.get("Status") == "healthy":
                            return
            time.sleep(1)
        fail("HOST_CUTOVER_SERVICE_NOT_READY", f"{service} did not reach required running/healthy state")

    def recreate(self, service: str) -> None:
        if service not in MUTABLE:
            fail("HOST_CUTOVER_SERVICE_NOT_ALLOWED", f"service {service} is outside signed mutable set")
        proc = self.compose("up", "-d", "--no-deps", "--force-recreate", "--no-build", "--pull", "never", service)
        if proc.returncode != 0:
            fail("HOST_CUTOVER_RECREATE_FAILED", f"failed to recreate {service}: {proc.stderr.decode('utf-8', errors='replace')[-400:]}")
        self.wait_service(service)

    def runtime_args(self, state: str, inspect: dict[str, Path]) -> list[str]:
        return [
            "--execution-core", str(self.execution_tool),
            "--cutover-plan", str(self.args.cutover_plan),
            "--baseline", str(self.args.baseline),
            "--baseline-verification", str(self.baseline_verification),
            "--journal", str(self.journal),
            "--key-file", str(self.args.key_file),
            "--state", state,
            "--app-inspect", str(inspect["app"]),
            "--export-inspect", str(inspect["export-cleanup"]),
            "--retention-inspect", str(inspect["retention-scan"]),
            "--libsql-inspect", str(inspect["libsql"]),
            "--caddy-inspect", str(inspect["caddy"]),
        ]

    def signed_runtime_attestation(self, state: str, inspect: dict[str, Path], output: Path) -> None:
        args = self.runtime_args(state, inspect)
        run_json(
            [sys.executable, str(self.runtime_attester), "prepare", *args, "--output", str(output)],
            "HOST_CUTOVER_RUNTIME_ATTESTATION_PREPARE_FAILED",
        )
        checked = run_json(
            [sys.executable, str(self.runtime_attester), "check", *args, "--attestation", str(output)],
            "HOST_CUTOVER_RUNTIME_ATTESTATION_CHECK_FAILED",
        )
        if checked.get("backupState") != state or checked.get("notificationsState") != "DISABLED":
            fail("HOST_CUTOVER_RUNTIME_ATTESTATION_STATE_INVALID", "signed runtime attestation returned unexpected state")

    def restore_prestate_env(self) -> None:
        verified = self.activation.verify_plan(self.activation_plan_checker, self.activation_plan, self.args.key_file)
        plan = self.activation.read_plan(self.activation_plan, verified, self.env_file)
        raw = self.activation.read_regular_bytes(self.env_file, "ENV_FILE")
        actual = self.activation.sha256_bytes(raw)
        if actual == plan["currentEnvFingerprint"]:
            rollback_raw = raw
        elif actual == plan["targetEnvFingerprint"]:
            rollback_raw = self.activation.reconstruct_rollback(raw, plan["rollbackDescriptor"])
            if self.activation.sha256_bytes(rollback_raw) != plan["currentEnvFingerprint"]:
                fail("HOST_CUTOVER_ROLLBACK_RECONSTRUCTION_MISMATCH", "rollback bytes do not match signed pre-state")
            self.activation.atomic_replace_env(
                self.env_file,
                plan["targetEnvFingerprint"],
                rollback_raw,
                plan["currentEnvFingerprint"],
            )
        else:
            blocked("HOST_CUTOVER_ENV_FINGERPRINT_UNKNOWN", "env matches neither signed target nor signed pre-state")
        valid, _, result = self.activation.runtime_attestation(self.runtime_checker, rollback_raw, "DISABLED")
        if not valid:
            fail("HOST_CUTOVER_ROLLBACK_ENV_ATTESTATION_FAILED", str(result.get("blockers") if isinstance(result, dict) else "invalid"))

    def target_flow(self, inspect: dict[str, Path], assessment: dict[str, Any]) -> dict[str, Any]:
        if assessment["status"] == "COMPLETED":
            return assessment
        if assessment.get("lastPhase") in {"ROLLBACK_STARTED", "ROLLBACK_RECREATED", "ROLLBACK_VERIFIED"}:
            return self.rollback_flow(inspect, assessment)
        self.verify_target_render()
        self.ensure_preflight_proof(inspect, assessment)

        while True:
            assessment = self.assess(inspect)
            status = assessment["status"]
            if status == "RECOVER_TARGET_RECREATED":
                self.event("TARGET_RECREATED", inspect)
                assessment = self.assess(inspect)
                break
            if status == "READY_TO_VALIDATE_LIVE":
                break
            if status == "READY_TO_COMPLETE":
                self.event("COMPLETED", inspect)
                return self.assess(inspect)
            if status == "COMPLETED":
                return assessment
            if status != "READY_TO_RECREATE_TARGET" or assessment.get("serviceMutationAllowed") is not True:
                blocked("HOST_CUTOVER_TARGET_MUTATION_NOT_ALLOWED", f"execution assessment is {status}")
            progressed = False
            for service in MUTABLE:
                state = self.service_privacy_state(service, inspect)
                if state == "UNKNOWN":
                    blocked("HOST_CUTOVER_MUTABLE_STATE_UNKNOWN", f"{service} runtime state is not bounded")
                if state == "ENABLED":
                    continue
                if state != "DISABLED":
                    blocked("HOST_CUTOVER_MUTABLE_STATE_INVALID", f"{service} state {state} cannot be targeted")
                self.recreate(service)
                progressed = True
                inspect = self.collect_inspect(f"target-{service}")
                after = self.assess(inspect)
                if after["status"] == "RECOVER_TARGET_RECREATED":
                    break
                if after["status"] != "READY_TO_RECREATE_TARGET":
                    blocked("HOST_CUTOVER_POST_RECREATE_STATE_INVALID", f"after {service}: {after['status']}")
            if not progressed and self.assess(inspect)["status"] != "RECOVER_TARGET_RECREATED":
                blocked("HOST_CUTOVER_TARGET_NO_PROGRESS", "no bounded target mutation remains but target state is incomplete")

        assessment = self.assess(inspect)
        if assessment["status"] == "READY_TO_VALIDATE_LIVE":
            self.signed_runtime_attestation("ENABLED", inspect, self.target_attestation)
            self.event("LIVE_VALIDATED", inspect, self.target_attestation)
            assessment = self.assess(inspect)
        if assessment["status"] == "READY_TO_COMPLETE":
            self.event("COMPLETED", inspect)
            assessment = self.assess(inspect)
        if assessment["status"] != "COMPLETED":
            blocked("HOST_CUTOVER_COMPLETION_NOT_REACHED", f"final target status is {assessment['status']}")
        return assessment

    def rollback_flow(self, inspect: dict[str, Path], assessment: dict[str, Any]) -> dict[str, Any]:
        if assessment["status"] == "COMPLETED":
            blocked("HOST_CUTOVER_ALREADY_COMPLETED", "completed cutover cannot be rolled back by this executor")
        if assessment["status"] == "ROLLED_BACK":
            return assessment
        if assessment.get("lastPhase") not in {"ROLLBACK_STARTED", "ROLLBACK_RECREATED", "ROLLBACK_VERIFIED"}:
            allowed = {"READY_TO_RECREATE_TARGET", "RECOVER_TARGET_RECREATED", "READY_TO_VALIDATE_LIVE", "READY_TO_COMPLETE"}
            if assessment["status"] not in allowed:
                blocked("HOST_CUTOVER_ROLLBACK_NOT_SAFE", f"cannot start rollback while assessment is {assessment['status']}")
            self.event("ROLLBACK_STARTED", inspect)
            assessment = self.assess(inspect)
        self.restore_prestate_env()

        while True:
            assessment = self.assess(inspect)
            status = assessment["status"]
            if status == "RECOVER_ROLLBACK_RECREATED":
                self.event("ROLLBACK_RECREATED", inspect)
                assessment = self.assess(inspect)
                break
            if status == "READY_TO_VERIFY_ROLLBACK":
                break
            if status == "ROLLED_BACK":
                return assessment
            if status != "READY_TO_RECREATE_ROLLBACK" or assessment.get("serviceMutationAllowed") is not True:
                blocked("HOST_CUTOVER_ROLLBACK_MUTATION_NOT_ALLOWED", f"rollback assessment is {status}")
            progressed = False
            for service in MUTABLE:
                state = self.service_privacy_state(service, inspect)
                if state == "UNKNOWN":
                    blocked("HOST_CUTOVER_ROLLBACK_STATE_UNKNOWN", f"{service} runtime state is not bounded")
                if state == "DISABLED":
                    continue
                if state != "ENABLED":
                    blocked("HOST_CUTOVER_ROLLBACK_STATE_INVALID", f"{service} state {state} cannot be rolled back")
                self.recreate(service)
                progressed = True
                inspect = self.collect_inspect(f"rollback-{service}")
                after = self.assess(inspect)
                if after["status"] == "RECOVER_ROLLBACK_RECREATED":
                    break
                if after["status"] != "READY_TO_RECREATE_ROLLBACK":
                    blocked("HOST_CUTOVER_POST_ROLLBACK_STATE_INVALID", f"after {service}: {after['status']}")
            if not progressed and self.assess(inspect)["status"] != "RECOVER_ROLLBACK_RECREATED":
                blocked("HOST_CUTOVER_ROLLBACK_NO_PROGRESS", "no rollback mutation remains but rollback state is incomplete")

        assessment = self.assess(inspect)
        if assessment["status"] == "READY_TO_VERIFY_ROLLBACK":
            self.signed_runtime_attestation("DISABLED", inspect, self.rollback_attestation)
            self.event("ROLLBACK_VERIFIED", inspect, self.rollback_attestation)
            assessment = self.assess(inspect)
        if assessment["status"] != "ROLLED_BACK":
            blocked("HOST_CUTOVER_ROLLBACK_NOT_VERIFIED", f"final rollback status is {assessment['status']}")
        return assessment

    def execute(self) -> dict[str, Any]:
        inspect = self.collect_inspect("initial")
        assessment = self.ensure_journal_started(inspect)
        if assessment["status"] == "COMPLETED":
            return assessment
        if assessment["status"] == "ROLLED_BACK" or assessment.get("lastPhase") in {"ROLLBACK_STARTED", "ROLLBACK_RECREATED", "ROLLBACK_VERIFIED"}:
            return self.rollback_flow(inspect, assessment)
        try:
            return self.target_flow(inspect, assessment)
        except HostCutoverBlocked:
            raise
        except HostCutoverError as target_error:
            # Re-observe before deciding whether automatic reverse mutation is safe.
            try:
                inspect = self.collect_inspect("failure")
                assessment = self.assess(inspect)
                rolled = self.rollback_flow(inspect, assessment)
                return {**rolled, "targetFailure": str(target_error), "automaticRollback": True}
            except HostCutoverBlocked:
                raise
            except Exception as rollback_error:  # noqa: BLE001
                raise HostCutoverBlocked(
                    f"HOST_CUTOVER_ROLLBACK_INCOMPLETE: target failure={target_error}; rollback failure={rollback_error}"
                ) from rollback_error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cutover-plan", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--execution-root", required=True, type=Path)
    parser.add_argument("--evidence-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        for field in ("cutover_plan", "baseline", "key_file", "execution_root", "evidence_root"):
            value = getattr(args, field)
            if not value.is_absolute():
                blocked("HOST_CUTOVER_PATH_NOT_ABSOLUTE", f"--{field.replace('_', '-')} must be absolute")
        executor = HostCutover(args)
        result = executor.execute()
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_BOUNDED_HOST_CUTOVER",
            "status": result.get("status"),
            "cutoverId": result.get("cutoverId"),
            "baselineId": result.get("baselineId"),
            "activationExecuted": result.get("activationExecuted", False),
            "serviceCutoverExecuted": result.get("serviceCutoverExecuted", False),
            "liveRuntimeAttested": result.get("liveRuntimeAttested", False),
            "automaticRollback": result.get("automaticRollback", False),
            "targetFailure": result.get("targetFailure"),
        }, separators=(",", ":"), ensure_ascii=False))
        return 0 if result.get("status") in {"COMPLETED", "ROLLED_BACK"} else 1
    except HostCutoverBlocked as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_BOUNDED_HOST_CUTOVER",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "activationExecuted": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 2
    except (OSError, ValueError, HostCutoverError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_BOUNDED_HOST_CUTOVER",
            "status": "FAILED",
            "blocker": str(exc).split(":", 1)[0],
            "activationExecuted": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())