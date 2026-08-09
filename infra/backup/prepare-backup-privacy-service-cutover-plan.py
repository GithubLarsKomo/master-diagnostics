#!/usr/bin/env python3
"""Prepare a signed read-only service cutover plan from verified target handoff evidence."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

PLAN_VERSION = 2
SIGNING_DOMAIN = b"masters:backup-privacy-service-cutover-plan:v2\n"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
TARGET = {
    "PRIVACY_BACKUP_STATE": "ENABLED",
    "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
}
PREFLIGHT_SERVICE = "privacy-check"
RECREATE_SERVICES = ("app", "export-cleanup", "retention-scan")
PRESERVE_SERVICES = ("libsql", "caddy")


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_file(path: Path, code: str, private: bool = False) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{code}_UNSAFE", "file must be an absolute regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o022:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must not be group/world writable")
    if private and mode & 0o077:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must be private")
    return path.read_bytes()


def read_key(path: Path) -> bytes:
    raw = read_file(path, "SERVICE_CUTOVER_KEY", private=True)
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("SERVICE_CUTOVER_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("SERVICE_CUTOVER_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def run_json(command: list[str]) -> tuple[int, dict[str, Any], bytes]:
    proc = subprocess.run(command, check=False, capture_output=True)
    raw = proc.stdout
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("SERVICE_CUTOVER_DEPENDENCY_OUTPUT_INVALID: command did not return JSON") from exc
    if not isinstance(result, dict):
        fail("SERVICE_CUTOVER_DEPENDENCY_OUTPUT_INVALID", "dependency output must be a JSON object")
    return proc.returncode, result, raw


def verify_handoff(args: argparse.Namespace) -> dict[str, Any]:
    checker = args.handoff_checker
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("TARGET_HANDOFF_CHECKER_UNSAFE", "target handoff checker is unsafe")
    code, result, _ = run_json([
        sys.executable,
        str(checker),
        "--plan-checker", str(args.activation_plan_checker),
        "--evidence-checker", str(args.execution_evidence_checker),
        "--target-config-checker", str(args.target_config_checker),
        "--plan", str(args.activation_plan),
        "--pending", str(args.pending),
        "--handoff", str(args.handoff),
        "--key-file", str(args.key_file),
        "--env-file", str(args.env_file),
    ])
    if (
        code != 0
        or result.get("status") != "TARGET_HANDOFF_VERIFIED"
        or result.get("serviceCutoverPlanningAllowed") is not True
        or result.get("serviceCutoverExecuted") is not False
        or result.get("liveRuntimeAttested") is not False
        or result.get("activationExecuted") is not False
    ):
        fail("TARGET_HANDOFF_NOT_VERIFIED", f"target handoff verification failed: {result.get('blocker')}")
    for field in (
        "planFingerprint",
        "handoffFingerprint",
        "handoffFileSha256",
        "targetConfigAttestationSha256",
        "targetEnvFingerprint",
    ):
        if not isinstance(result.get(field), str) or not SHA256.fullmatch(result[field]):
            fail("TARGET_HANDOFF_BINDING_INVALID", f"verified handoff {field} is invalid")
    activation_id = result.get("activationId")
    if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
        fail("TARGET_HANDOFF_BINDING_INVALID", "verified activation ID is invalid")
    if not isinstance(result.get("executionId"), str) or not result["executionId"].startswith("execution-"):
        fail("TARGET_HANDOFF_BINDING_INVALID", "verified execution ID is invalid")
    return result


def render_compose(compose_file: Path, env_file: Path) -> tuple[bytes, dict[str, Any]]:
    read_file(compose_file, "SERVICE_CUTOVER_COMPOSE")
    read_file(env_file, "ENV_FILE", private=True)
    proc = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(compose_file), "config", "--format", "json"],
        check=False,
        capture_output=True,
    )
    if proc.returncode != 0:
        fail("SERVICE_CUTOVER_COMPOSE_RENDER_FAILED", proc.stderr.decode("utf-8", errors="replace")[:300])
    try:
        rendered = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("SERVICE_CUTOVER_COMPOSE_RENDER_INVALID: compose config did not return JSON") from exc
    if not isinstance(rendered, dict):
        fail("SERVICE_CUTOVER_COMPOSE_RENDER_INVALID", "rendered compose must be an object")
    return (canonical_json(rendered) + "\n").encode("utf-8"), rendered


def environment_of(service: dict[str, Any]) -> dict[str, str]:
    raw = service.get("environment")
    if not isinstance(raw, dict):
        fail("SERVICE_CUTOVER_ENVIRONMENT_MISSING", "service environment is not rendered as an object")
    return {str(key): "" if value is None else str(value) for key, value in raw.items()}


def validate_rendered_compose(rendered: dict[str, Any]) -> None:
    services = rendered.get("services")
    if not isinstance(services, dict):
        fail("SERVICE_CUTOVER_SERVICES_MISSING", "rendered compose has no services object")
    required = {PREFLIGHT_SERVICE, *RECREATE_SERVICES, *PRESERVE_SERVICES}
    if not required.issubset(services):
        fail("SERVICE_CUTOVER_SERVICE_SET_MISSING", "required service is missing from rendered compose")
    for name in (PREFLIGHT_SERVICE, *RECREATE_SERVICES):
        service = services.get(name)
        if not isinstance(service, dict):
            fail("SERVICE_CUTOVER_SERVICE_INVALID", f"service {name} is invalid")
        env = environment_of(service)
        for key, expected in TARGET.items():
            if env.get(key) != expected:
                fail("SERVICE_CUTOVER_TARGET_ENV_MISMATCH", f"{name} does not render {key}={expected}")
    privacy = services[PREFLIGHT_SERVICE]
    command = privacy.get("command")
    command_text = " ".join(str(part) for part in command) if isinstance(command, list) else str(command or "")
    if "privacy-capabilities:check" not in command_text:
        fail("SERVICE_CUTOVER_PREFLIGHT_COMMAND_INVALID", "privacy-check does not run canonical capability checker")
    app = services["app"]
    depends = app.get("depends_on")
    if not isinstance(depends, dict) or PREFLIGHT_SERVICE not in depends:
        fail("SERVICE_CUTOVER_APP_DEPENDENCY_INVALID", "app does not depend on privacy-check")
    privacy_dependency = depends[PREFLIGHT_SERVICE]
    if not isinstance(privacy_dependency, dict) or privacy_dependency.get("condition") != "service_completed_successfully":
        fail("SERVICE_CUTOVER_APP_DEPENDENCY_INVALID", "app privacy-check dependency must require successful completion")


def safe_output_root(path: Path) -> None:
    if not path.is_absolute():
        fail("SERVICE_CUTOVER_OUTPUT_NOT_ABSOLUTE", "output root must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("SERVICE_CUTOVER_OUTPUT_UNSAFE", "output root must be a non-symlink directory")
    os.chmod(path, 0o700)
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("SERVICE_CUTOVER_OUTPUT_PERMISSIONS_UNSAFE", "output root must be private")


def sign(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def build_record(args: argparse.Namespace, handoff: dict[str, Any], rendered_raw: bytes) -> dict[str, Any]:
    binding = {
        "activationId": handoff["activationId"],
        "executionId": handoff["executionId"],
        "activationPlanPath": str(args.activation_plan),
        "activationPlanFileSha256": sha256_bytes(read_file(args.activation_plan, "ACTIVATION_PLAN", private=True)),
        "pendingEvidencePath": str(args.pending),
        "pendingEvidenceFileSha256": sha256_bytes(read_file(args.pending, "ACTIVATION_PENDING", private=True)),
        "targetHandoffPath": str(args.handoff),
        "targetHandoffFingerprint": handoff["handoffFingerprint"],
        "targetHandoffFileSha256": handoff["handoffFileSha256"],
        "targetConfigAttestationSha256": handoff["targetConfigAttestationSha256"],
        "activationPlanFingerprint": handoff["planFingerprint"],
        "envFilePath": str(args.env_file),
        "targetEnvFingerprint": handoff["targetEnvFingerprint"],
        "composeFilePath": str(args.compose_file),
        "composeFileSha256": sha256_bytes(read_file(args.compose_file, "SERVICE_CUTOVER_COMPOSE")),
        "renderedComposeSha256": sha256_bytes(rendered_raw),
    }
    cutover_id = "cutover-" + hashlib.sha256(canonical_json(binding).encode("utf-8")).hexdigest()[:32]
    record: dict[str, Any] = {
        "serviceCutoverPlanVersion": PLAN_VERSION,
        "cutoverId": cutover_id,
        **binding,
        "preflightService": PREFLIGHT_SERVICE,
        "recreateServices": list(RECREATE_SERVICES),
        "preserveServices": list(PRESERVE_SERVICES),
        "requiredPrivacyEnvironment": TARGET,
        "targetHandoffMustRemainVerified": True,
        "preflightMustSucceedBeforeMutation": True,
        "liveBaselineRequiredBeforeMutation": True,
        "renderedComposeMustRemainBound": True,
        "caddyContainerMustBePreserved": True,
        "libsqlContainerMustBePreserved": True,
        "appHealthcheckRequired": True,
        "backgroundServicesRunningRequired": True,
        "liveRuntimeEnvironmentAttestationRequired": True,
        "rollbackOnCutoverFailureRequired": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }
    record["cutoverPlanFingerprint"] = sha256_bytes(canonical_json(record).encode("utf-8"))
    return record


def persist(path: Path, envelope: dict[str, Any]) -> bool:
    if path.exists():
        raw = read_file(path, "SERVICE_CUTOVER_PLAN", private=True)
        try:
            existing = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("SERVICE_CUTOVER_PLAN_CONFLICT: existing plan is not JSON") from exc
        if existing != envelope:
            fail("SERVICE_CUTOVER_PLAN_CONFLICT", "existing deterministic plan differs")
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(envelope, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    return True


def add_chain_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--handoff-checker", required=True, type=Path)
    parser.add_argument("--activation-plan-checker", required=True, type=Path)
    parser.add_argument("--execution-evidence-checker", required=True, type=Path)
    parser.add_argument("--target-config-checker", required=True, type=Path)
    parser.add_argument("--activation-plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--handoff", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)


def main() -> int:
    parser = argparse.ArgumentParser()
    add_chain_args(parser)
    parser.add_argument("--output-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        key = read_key(args.key_file)
        handoff = verify_handoff(args)
        rendered_raw, rendered = render_compose(args.compose_file, args.env_file)
        validate_rendered_compose(rendered)
        safe_output_root(args.output_root)
        record = build_record(args, handoff, rendered_raw)
        envelope = {"envelopeVersion": 1, "record": record, "signature": sign(record, key)}
        path = args.output_root / f"{record['cutoverId']}.json"
        created = persist(path, envelope)
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN",
            "status": "SERVICE_CUTOVER_PLAN_READY",
            "serviceCutoverPlanVersion": PLAN_VERSION,
            "cutoverId": record["cutoverId"],
            "activationId": record["activationId"],
            "cutoverPlanFingerprint": record["cutoverPlanFingerprint"],
            "targetHandoffFingerprint": record["targetHandoffFingerprint"],
            "planPath": str(path),
            "planCreated": created,
            "planReused": not created,
            "liveBaselineRequired": True,
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN",
            "status": "BLOCKED",
            "blocker": blocker,
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
