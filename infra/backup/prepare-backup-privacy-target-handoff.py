#!/usr/bin/env python3
"""Atomically stage target .env and emit nonterminal signed handoff evidence.

This is the production bridge between reversible env activation and a later
live-service cutover. It never claims that running services adopted ENABLED.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-activation-target-handoff:v1\n"
HANDOFF_VERSION = 1
FILES = {
    "TARGET_HANDOFF_READY": "activation-target-handoff.json",
    "ROLLBACK_STARTED": "activation-target-handoff-rollback-started.json",
    "ROLLBACK_VERIFIED": "activation-target-handoff-rollback-verified.json",
}
FAILURE_REASONS = {
    "TARGET_CONFIGURATION_ATTESTATION_FAILED",
    "TARGET_HANDOFF_REVALIDATION_FAILED",
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def load_legacy(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("TARGET_HANDOFF_LEGACY_EXECUTOR_UNSAFE", "legacy executor must be an absolute regular file")
    spec = importlib.util.spec_from_file_location("backup_privacy_activation_executor", path)
    if spec is None or spec.loader is None:
        fail("TARGET_HANDOFF_LEGACY_EXECUTOR_INVALID", "could not load activation executor helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    required = (
        "read_key", "verify_plan", "read_plan", "safe_execution_dir", "verify_pending",
        "marker_binding", "read_regular_bytes", "sha256_bytes", "load_planner",
        "atomic_replace_env", "reconstruct_rollback", "parse_privacy_environment",
        "runtime_attestation",
    )
    for name in required:
        if not callable(getattr(module, name, None)):
            fail("TARGET_HANDOFF_LEGACY_EXECUTOR_INVALID", f"missing helper {name}")
    return module


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_timestamp(value: str, legacy: Any) -> None:
    legacy.validate_timestamp(value)


def checker_command(path: Path) -> list[str]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("TARGET_CONFIGURATION_CHECKER_UNSAFE", "target configuration checker must be an absolute regular file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("TARGET_CONFIGURATION_CHECKER_PERMISSIONS_UNSAFE", "target configuration checker must not be group/world writable")
    if path.suffix == ".py":
        return [sys.executable, str(path)]
    if path.suffix == ".sh":
        return ["bash", str(path)]
    return [str(path)]


def target_config_attestation(legacy: Any, checker: Path, raw: bytes) -> tuple[bool, str, dict[str, Any]]:
    privacy = legacy.parse_privacy_environment(raw)
    child_env = dict(os.environ)
    for key in legacy.PRIVACY_ENV_KEYS:
        child_env.pop(key, None)
    child_env.update(privacy)
    proc = subprocess.run(checker_command(checker), check=False, capture_output=True, env=child_env)
    stdout = proc.stdout
    digest = sha256_bytes(stdout)
    try:
        result = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("TARGET_CONFIGURATION_CHECK_OUTPUT_INVALID: checker did not return one JSON object") from exc
    if not isinstance(result, dict):
        fail("TARGET_CONFIGURATION_CHECK_OUTPUT_INVALID", "target checker output must be an object")
    valid = (
        proc.returncode == 0
        and result.get("readyForIrreversibleProcessing") is True
        and result.get("backupState") == "ENABLED"
        and result.get("backupPolicyVersion") == "1.0.0"
        and result.get("blockers") == []
        and result.get("attestationScope") == "TARGET_CONFIGURATION_POLICY_ONLY"
        and result.get("liveRuntimeAttested") is False
        and result.get("activationExecuted") is False
    )
    return valid, digest, result


def sign(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def marker_record(
    phase: str,
    binding: dict[str, Any],
    *,
    checker_path: Path,
    checker_sha: str,
    target_attestation_sha: str,
    recorded_at: str,
    failure_reason: str | None = None,
) -> dict[str, Any]:
    if phase not in FILES:
        fail("TARGET_HANDOFF_PHASE_INVALID", "unsupported target-handoff phase")
    if failure_reason is not None and failure_reason not in FAILURE_REASONS:
        fail("TARGET_HANDOFF_FAILURE_REASON_INVALID", "unsupported failure reason")
    record: dict[str, Any] = {
        "targetHandoffVersion": HANDOFF_VERSION,
        "phase": phase,
        "recordedAt": recorded_at,
        **binding,
        "targetConfigCheckerPath": str(checker_path),
        "targetConfigCheckerFileSha256": checker_sha,
        "targetConfigAttestationSha256": target_attestation_sha,
        "failureReasonCode": failure_reason,
        "envMutationApplied": phase in {"TARGET_HANDOFF_READY", "ROLLBACK_STARTED"},
        "rollbackVerified": phase == "ROLLBACK_VERIFIED",
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
        "terminal": phase == "ROLLBACK_VERIFIED",
    }
    record["handoffFingerprint"] = sha256_bytes(canonical_json(record).encode("utf-8"))
    return record


def validate_marker(record: dict[str, Any], phase: str, binding: dict[str, Any], checker: Path, checker_sha: str, legacy: Any) -> None:
    if record.get("targetHandoffVersion") != HANDOFF_VERSION or record.get("phase") != phase:
        fail("TARGET_HANDOFF_MARKER_INVALID", "marker version or phase is invalid")
    recorded_at = record.get("recordedAt")
    if not isinstance(recorded_at, str):
        fail("TARGET_HANDOFF_TIMESTAMP_INVALID", "marker timestamp is missing")
    validate_timestamp(recorded_at, legacy)
    for field, expected in binding.items():
        if record.get(field) != expected:
            fail("TARGET_HANDOFF_MARKER_BINDING_MISMATCH", f"marker field {field} differs from execution binding")
    if record.get("targetConfigCheckerPath") != str(checker) or record.get("targetConfigCheckerFileSha256") != checker_sha:
        fail("TARGET_HANDOFF_CHECKER_BINDING_MISMATCH", "target checker path/hash differs from marker")
    attestation_sha = record.get("targetConfigAttestationSha256")
    if not isinstance(attestation_sha, str) or not legacy.SHA256.fullmatch(attestation_sha):
        fail("TARGET_HANDOFF_ATTESTATION_SHA_INVALID", "target attestation SHA-256 is invalid")
    failure = record.get("failureReasonCode")
    if phase == "ROLLBACK_STARTED":
        if failure not in FAILURE_REASONS:
            fail("TARGET_HANDOFF_FAILURE_REASON_INVALID", "rollback-started reason is invalid")
    elif failure is not None:
        fail("TARGET_HANDOFF_FAILURE_REASON_UNEXPECTED", "failure reason is only allowed for rollback-started")
    expected_flags = {
        "envMutationApplied": phase in {"TARGET_HANDOFF_READY", "ROLLBACK_STARTED"},
        "rollbackVerified": phase == "ROLLBACK_VERIFIED",
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
        "terminal": phase == "ROLLBACK_VERIFIED",
    }
    for field, expected in expected_flags.items():
        if record.get(field) is not expected:
            fail("TARGET_HANDOFF_MARKER_STATE_INVALID", f"marker field {field} is invalid")
    fingerprint = record.get("handoffFingerprint")
    if not isinstance(fingerprint, str) or not legacy.SHA256.fullmatch(fingerprint):
        fail("TARGET_HANDOFF_FINGERPRINT_INVALID", "handoff fingerprint is invalid")
    body = dict(record)
    body.pop("handoffFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode("utf-8"))):
        fail("TARGET_HANDOFF_FINGERPRINT_MISMATCH", "handoff fingerprint does not match record")


def read_marker(path: Path, phase: str, binding: dict[str, Any], checker: Path, checker_sha: str, key: bytes, legacy: Any) -> dict[str, Any] | None:
    if not path.exists():
        return None
    raw = legacy.read_regular_bytes(path, "TARGET_HANDOFF_MARKER")
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("TARGET_HANDOFF_MARKER_INVALID: marker is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("TARGET_HANDOFF_MARKER_INVALID", "marker envelope is invalid")
    record = envelope["record"]
    validate_marker(record, phase, binding, checker, checker_sha, legacy)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not legacy.HMAC_SHA256.fullmatch(signature):
        fail("TARGET_HANDOFF_SIGNATURE_INVALID", "marker signature is invalid")
    if not hmac.compare_digest(signature, sign(record, key)):
        fail("TARGET_HANDOFF_SIGNATURE_MISMATCH", "marker HMAC does not match")
    return envelope


def persist(path: Path, record: dict[str, Any], key: bytes) -> dict[str, Any]:
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign(record, key)}
    serialized = (json.dumps(envelope, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if path.exists():
        fail("TARGET_HANDOFF_MARKER_CONFLICT", f"marker already exists: {path.name}")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(serialized)
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
    return envelope


def output(status: str, binding: dict[str, Any], *, handoff_fp: str | None = None, attestation_sha: str | None = None, blocker: str | None = None) -> dict[str, Any]:
    ready = status in {"TARGET_HANDOFF_READY", "ALREADY_TARGET_HANDOFF_READY"}
    return {
        "mode": "BACKUP_PRIVACY_TARGET_HANDOFF",
        "status": status,
        "activationId": binding.get("activationId"),
        "executionId": binding.get("executionId"),
        "planFingerprint": binding.get("planFingerprint"),
        "handoffFingerprint": handoff_fp,
        "targetConfigAttestationSha256": attestation_sha,
        "blocker": blocker,
        "serviceCutoverPlanningAllowed": ready,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }


def rollback(
    legacy: Any,
    *,
    args: argparse.Namespace,
    plan: dict[str, Any],
    binding: dict[str, Any],
    paths: dict[str, Path],
    key: bytes,
    checker_sha: str,
    target_attestation_sha: str,
    failure_reason: str,
    raw: bytes,
) -> tuple[dict[str, Any], int]:
    started = marker_record(
        "ROLLBACK_STARTED",
        binding,
        checker_path=args.target_config_checker,
        checker_sha=checker_sha,
        target_attestation_sha=target_attestation_sha,
        recorded_at=args.recorded_at or canonical_now(),
        failure_reason=failure_reason,
    )
    persist(paths["ROLLBACK_STARTED"], started, key)
    rollback_raw = legacy.reconstruct_rollback(raw, plan["rollbackDescriptor"])
    if legacy.sha256_bytes(rollback_raw) != plan["currentEnvFingerprint"]:
        fail("TARGET_HANDOFF_ROLLBACK_RECONSTRUCTION_MISMATCH", "rollback bytes do not match signed pre-state")
    legacy.atomic_replace_env(args.env_file, plan["targetEnvFingerprint"], rollback_raw, plan["currentEnvFingerprint"])
    rollback_valid, rollback_sha, _ = legacy.runtime_attestation(args.rollback_runtime_checker, rollback_raw, "DISABLED")
    if not rollback_valid:
        fail("TARGET_HANDOFF_ROLLBACK_RUNTIME_ATTESTATION_FAILED", "DISABLED runtime policy did not validate after rollback")
    verified = marker_record(
        "ROLLBACK_VERIFIED",
        binding,
        checker_path=args.target_config_checker,
        checker_sha=checker_sha,
        target_attestation_sha=target_attestation_sha,
        recorded_at=args.recorded_at or canonical_now(),
    )
    persist(paths["ROLLBACK_VERIFIED"], verified, key)
    return output("ROLLED_BACK", binding, attestation_sha=rollback_sha), 1


def recover_rollback(
    legacy: Any,
    *,
    args: argparse.Namespace,
    plan: dict[str, Any],
    binding: dict[str, Any],
    paths: dict[str, Path],
    key: bytes,
    checker_sha: str,
    started: dict[str, Any],
) -> tuple[dict[str, Any], int]:
    raw = legacy.read_regular_bytes(args.env_file, "ENV_FILE")
    actual = legacy.sha256_bytes(raw)
    if actual == plan["targetEnvFingerprint"]:
        rollback_raw = legacy.reconstruct_rollback(raw, plan["rollbackDescriptor"])
        if legacy.sha256_bytes(rollback_raw) != plan["currentEnvFingerprint"]:
            fail("TARGET_HANDOFF_ROLLBACK_RECONSTRUCTION_MISMATCH", "rollback bytes do not match signed pre-state")
        legacy.atomic_replace_env(args.env_file, plan["targetEnvFingerprint"], rollback_raw, plan["currentEnvFingerprint"])
        raw = rollback_raw
    elif actual == plan["currentEnvFingerprint"]:
        pass
    else:
        fail("TARGET_HANDOFF_ENV_DRIFT", "rollback recovery env matches neither signed target nor original state")
    rollback_valid, rollback_sha, _ = legacy.runtime_attestation(args.rollback_runtime_checker, raw, "DISABLED")
    if not rollback_valid:
        fail("TARGET_HANDOFF_ROLLBACK_RUNTIME_ATTESTATION_FAILED", "DISABLED runtime policy did not validate during rollback recovery")
    verified = marker_record(
        "ROLLBACK_VERIFIED",
        binding,
        checker_path=args.target_config_checker,
        checker_sha=checker_sha,
        target_attestation_sha=started["record"]["targetConfigAttestationSha256"],
        recorded_at=args.recorded_at or canonical_now(),
    )
    persist(paths["ROLLBACK_VERIFIED"], verified, key)
    return output("ROLLED_BACK", binding, attestation_sha=rollback_sha), 1


def execute(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    legacy = load_legacy(args.legacy_executor)
    key = legacy.read_key(args.key_file)
    checker_raw = legacy.read_regular_bytes(args.target_config_checker, "TARGET_CONFIGURATION_CHECKER")
    checker_sha = legacy.sha256_bytes(checker_raw)
    verified = legacy.verify_plan(args.plan_checker, args.plan, args.key_file)
    plan = legacy.read_plan(args.plan, verified, args.env_file)
    directory = legacy.safe_execution_dir(args.pending, plan["activationId"])
    lock_path = directory / "activation-executor.lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(lock_fd, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(lock_fd)
        raise ValueError("TARGET_HANDOFF_BUSY: another activation process holds the lock") from exc
    try:
        assessment = legacy.verify_pending(args.evidence_checker, args.plan_checker, args.plan, args.key_file, args.env_file, args.pending)
        if assessment.get("activationId") != plan["activationId"] or assessment.get("planFingerprint") != plan["planFingerprint"]:
            fail("TARGET_HANDOFF_EXECUTION_BINDING_MISMATCH", "PENDING evidence differs from plan")
        binding = legacy.marker_binding(plan, assessment, args.pending)
        paths = {phase: directory / name for phase, name in FILES.items()}

        # Legacy terminal/rollback markers are deliberately not accepted as the new trust boundary.
        for legacy_name in (
            "activation-execution-completed.json",
            "activation-execution-rollback-started.json",
            "activation-execution-rollback-verified.json",
        ):
            if directory.joinpath(legacy_name).exists():
                fail("TARGET_HANDOFF_LEGACY_TERMINAL_CONFLICT", f"legacy marker present: {legacy_name}")

        handoff = read_marker(paths["TARGET_HANDOFF_READY"], "TARGET_HANDOFF_READY", binding, args.target_config_checker, checker_sha, key, legacy)
        rollback_started = read_marker(paths["ROLLBACK_STARTED"], "ROLLBACK_STARTED", binding, args.target_config_checker, checker_sha, key, legacy)
        rollback_verified = read_marker(paths["ROLLBACK_VERIFIED"], "ROLLBACK_VERIFIED", binding, args.target_config_checker, checker_sha, key, legacy)
        if handoff is not None and (rollback_started is not None or rollback_verified is not None):
            fail("TARGET_HANDOFF_STATE_CONFLICT", "handoff and rollback evidence cannot coexist")
        if rollback_verified is not None and rollback_started is None:
            fail("TARGET_HANDOFF_STATE_CONFLICT", "ROLLBACK_VERIFIED requires ROLLBACK_STARTED")

        raw = legacy.read_regular_bytes(args.env_file, "ENV_FILE")
        actual = legacy.sha256_bytes(raw)
        if rollback_verified is not None:
            if actual != plan["currentEnvFingerprint"]:
                fail("TARGET_HANDOFF_ROLLBACK_ENV_DRIFT", "verified rollback no longer matches original env")
            return output("ALREADY_ROLLED_BACK", binding), 1
        if rollback_started is not None:
            return recover_rollback(
                legacy,
                args=args,
                plan=plan,
                binding=binding,
                paths=paths,
                key=key,
                checker_sha=checker_sha,
                started=rollback_started,
            )

        if handoff is not None:
            if actual != plan["targetEnvFingerprint"]:
                fail("TARGET_HANDOFF_ENV_DRIFT", "signed handoff no longer matches target env")
            valid, digest, _ = target_config_attestation(legacy, args.target_config_checker, raw)
            if valid and digest == handoff["record"]["targetConfigAttestationSha256"]:
                return output(
                    "ALREADY_TARGET_HANDOFF_READY",
                    binding,
                    handoff_fp=handoff["record"]["handoffFingerprint"],
                    attestation_sha=digest,
                ), 0
            return rollback(
                legacy,
                args=args,
                plan=plan,
                binding=binding,
                paths=paths,
                key=key,
                checker_sha=checker_sha,
                target_attestation_sha=digest,
                failure_reason="TARGET_HANDOFF_REVALIDATION_FAILED",
                raw=raw,
            )

        if actual == plan["currentEnvFingerprint"]:
            planner = legacy.load_planner(args.planner)
            target_raw, _, rollback_descriptor = planner.build_reversible_target_env(raw)
            if rollback_descriptor != plan["rollbackDescriptor"]:
                fail("TARGET_HANDOFF_ROLLBACK_DESCRIPTOR_MISMATCH", "reconstructed rollback descriptor differs from signed plan")
            if legacy.sha256_bytes(target_raw) != plan["targetEnvFingerprint"]:
                fail("TARGET_HANDOFF_TARGET_RECONSTRUCTION_MISMATCH", "reconstructed target bytes differ from signed plan")
            legacy.atomic_replace_env(args.env_file, plan["currentEnvFingerprint"], target_raw, plan["targetEnvFingerprint"])
            raw = target_raw
        elif actual == plan["targetEnvFingerprint"]:
            pass
        else:
            fail("TARGET_HANDOFF_ENV_DRIFT", "env matches neither signed pre-state nor target state")

        valid, digest, _ = target_config_attestation(legacy, args.target_config_checker, raw)
        if not valid:
            return rollback(
                legacy,
                args=args,
                plan=plan,
                binding=binding,
                paths=paths,
                key=key,
                checker_sha=checker_sha,
                target_attestation_sha=digest,
                failure_reason="TARGET_CONFIGURATION_ATTESTATION_FAILED",
                raw=raw,
            )
        recorded_at = args.recorded_at or canonical_now()
        validate_timestamp(recorded_at, legacy)
        record = marker_record(
            "TARGET_HANDOFF_READY",
            binding,
            checker_path=args.target_config_checker,
            checker_sha=checker_sha,
            target_attestation_sha=digest,
            recorded_at=recorded_at,
        )
        persist(paths["TARGET_HANDOFF_READY"], record, key)
        return output(
            "TARGET_HANDOFF_READY",
            binding,
            handoff_fp=record["handoffFingerprint"],
            attestation_sha=digest,
        ), 0
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-executor", type=Path, default=root / "infra/backup/execute-backup-privacy-activation.py")
    parser.add_argument("--plan-checker", type=Path, default=root / "infra/backup/check-backup-privacy-activation-plan.py")
    parser.add_argument("--evidence-checker", type=Path, default=root / "infra/backup/backup-privacy-activation-execution.py")
    parser.add_argument("--planner", type=Path, default=root / "infra/backup/prepare-backup-privacy-activation-plan.py")
    parser.add_argument("--target-config-checker", type=Path, default=root / "infra/backup/check-backup-privacy-target-config.py")
    parser.add_argument("--rollback-runtime-checker", type=Path, default=root / "infra/backup/check-backup-privacy-runtime.sh")
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--recorded-at")
    args = parser.parse_args()
    if args.recorded_at is not None:
        try:
            load_legacy(args.legacy_executor).validate_timestamp(args.recorded_at)
        except (OSError, ValueError) as exc:
            print(json.dumps({
                "mode": "BACKUP_PRIVACY_TARGET_HANDOFF",
                "status": "BLOCKED",
                "blocker": str(exc).split(":", 1)[0],
                "serviceCutoverPlanningAllowed": False,
                "serviceCutoverExecuted": False,
                "liveRuntimeAttested": False,
                "activationExecuted": False,
            }, separators=(",", ":")))
            return 2
    try:
        result, code = execute(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return code
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_TARGET_HANDOFF",
            "status": "BLOCKED",
            "blocker": blocker,
            "serviceCutoverPlanningAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
