#!/usr/bin/env python3
"""Stage the plan-bound target env and persist a signed non-terminal live-runtime handoff."""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any

HANDOFF_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-live-handoff:v1\n"
HANDOFF_FILE = "activation-execution-live-runtime-handoff.json"
HANDOFF_PHASE = "TARGET_APPLIED"
HANDOFF_REASON = "LIVE_RUNTIME_ATTESTATION_REQUIRED"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def load_executor(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("LIVE_HANDOFF_EXECUTOR_MODULE_UNSAFE", "executor module must be an absolute regular non-symlink file")
    spec = importlib.util.spec_from_file_location("backup_privacy_activation_executor", path)
    if spec is None or spec.loader is None:
        fail("LIVE_HANDOFF_EXECUTOR_MODULE_INVALID", "could not load activation executor module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    required = (
        "read_key", "verify_plan", "read_plan", "safe_execution_dir", "verify_pending", "marker_binding",
        "read_marker", "marker_record", "persist_marker", "read_regular_bytes", "sha256_bytes", "load_planner",
        "atomic_replace_env", "runtime_attestation", "reconstruct_rollback",
    )
    if any(not callable(getattr(module, name, None)) for name in required):
        fail("LIVE_HANDOFF_EXECUTOR_MODULE_INVALID", "executor module is missing required bounded primitives")
    return module


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def record_fingerprint(record: dict[str, Any]) -> str:
    body = dict(record)
    body.pop("handoffFingerprint", None)
    return sha256_bytes(canonical_json(body).encode("utf-8"))


def make_record(binding: dict[str, Any], static_sha: str, recorded_at: str, executor: Any) -> dict[str, Any]:
    if not SHA256.fullmatch(static_sha):
        fail("LIVE_HANDOFF_STATIC_ATTESTATION_INVALID", "static policy attestation SHA-256 is invalid")
    executor.validate_timestamp(recorded_at)
    record = {
        "liveHandoffVersion": HANDOFF_VERSION,
        "phase": HANDOFF_PHASE,
        "recordedAt": recorded_at,
        **binding,
        "staticPolicyAttestationSha256": static_sha,
        "handoffReasonCode": HANDOFF_REASON,
        "requiredNextProof": "LIVE_CLUB_PROCESS_ATTESTATION",
        "runtimeConfigurationChanged": True,
        "activationExecuted": False,
        "terminal": False,
    }
    record["handoffFingerprint"] = record_fingerprint(record)
    return record


def validate_record(record: dict[str, Any], binding: dict[str, Any], executor: Any) -> None:
    if record.get("liveHandoffVersion") != HANDOFF_VERSION or record.get("phase") != HANDOFF_PHASE:
        fail("LIVE_HANDOFF_VERSION_INVALID", "handoff version or phase is invalid")
    recorded_at = record.get("recordedAt")
    if not isinstance(recorded_at, str):
        fail("LIVE_HANDOFF_TIMESTAMP_INVALID", "recordedAt is missing")
    executor.validate_timestamp(recorded_at)
    for field, expected in binding.items():
        if record.get(field) != expected:
            fail("LIVE_HANDOFF_BINDING_MISMATCH", f"handoff field {field} does not match activation evidence")
    static_sha = record.get("staticPolicyAttestationSha256")
    if not isinstance(static_sha, str) or not SHA256.fullmatch(static_sha):
        fail("LIVE_HANDOFF_STATIC_ATTESTATION_INVALID", "handoff static policy attestation SHA-256 is invalid")
    if (
        record.get("handoffReasonCode") != HANDOFF_REASON
        or record.get("requiredNextProof") != "LIVE_CLUB_PROCESS_ATTESTATION"
        or record.get("runtimeConfigurationChanged") is not True
        or record.get("activationExecuted") is not False
        or record.get("terminal") is not False
    ):
        fail("LIVE_HANDOFF_STATE_INVALID", "handoff safety state is invalid")
    fingerprint = record.get("handoffFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("LIVE_HANDOFF_FINGERPRINT_INVALID", "handoff fingerprint is invalid")
    if not hmac.compare_digest(fingerprint, record_fingerprint(record)):
        fail("LIVE_HANDOFF_FINGERPRINT_MISMATCH", "handoff fingerprint does not match record")


def read_handoff(path: Path, binding: dict[str, Any], key: bytes, executor: Any) -> dict[str, Any] | None:
    if not path.exists():
        return None
    raw = executor.read_regular_bytes(path, "LIVE_HANDOFF_FILE")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("LIVE_HANDOFF_PERMISSIONS_UNSAFE", "handoff file must be private")
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("LIVE_HANDOFF_INVALID: handoff is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("LIVE_HANDOFF_INVALID", "handoff envelope is invalid")
    record = envelope["record"]
    validate_record(record, binding, executor)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("LIVE_HANDOFF_SIGNATURE_INVALID", "handoff signature is invalid")
    if not hmac.compare_digest(signature, sign_record(record, key)):
        fail("LIVE_HANDOFF_SIGNATURE_MISMATCH", "handoff HMAC does not match")
    return envelope


def persist_handoff(path: Path, record: dict[str, Any], key: bytes, binding: dict[str, Any], executor: Any) -> tuple[dict[str, Any], bool]:
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(record, key)}
    serialized = (json.dumps(envelope, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if path.exists():
        existing = read_handoff(path, binding, key, executor)
        if existing != envelope:
            fail("LIVE_HANDOFF_CONFLICT", "existing handoff differs from requested evidence")
        return envelope, False
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
    return envelope, True


def expected_boundary(valid: bool, result: dict[str, Any]) -> bool:
    return (
        valid is False
        and result.get("readyForIrreversibleProcessing") is False
        and result.get("backupState") == "ENABLED"
        and result.get("attestationScope") == "STATIC_ENV_POLICY_ONLY"
        and result.get("blockers") == [HANDOFF_REASON]
    )


def terminal_markers(executor: Any, directory: Path, binding: dict[str, Any], key: bytes) -> tuple[Any, Any, Any]:
    completed = executor.read_marker(directory / executor.MARKER_FILES["COMPLETED"], "COMPLETED", binding, key)
    rollback_started = executor.read_marker(directory / executor.MARKER_FILES["ROLLBACK_STARTED"], "ROLLBACK_STARTED", binding, key)
    rollback_verified = executor.read_marker(directory / executor.MARKER_FILES["ROLLBACK_VERIFIED"], "ROLLBACK_VERIFIED", binding, key)
    return completed, rollback_started, rollback_verified


def rollback_unexpected_failure(
    executor: Any,
    args: argparse.Namespace,
    directory: Path,
    binding: dict[str, Any],
    key: bytes,
    raw: bytes,
    runtime_sha: str,
) -> tuple[dict[str, Any], int]:
    rollback_started_path = directory / executor.MARKER_FILES["ROLLBACK_STARTED"]
    rollback_verified_path = directory / executor.MARKER_FILES["ROLLBACK_VERIFIED"]
    started = executor.marker_record(
        "ROLLBACK_STARTED",
        binding,
        runtime_sha=runtime_sha,
        reason="RUNTIME_ATTESTATION_FAILED",
        recorded_at=args.recorded_at,
    )
    executor.persist_marker(rollback_started_path, started, key)
    rollback_raw = executor.reconstruct_rollback(raw, args.plan_record["rollbackDescriptor"])
    if executor.sha256_bytes(rollback_raw) != args.plan_record["currentEnvFingerprint"]:
        fail("LIVE_HANDOFF_ROLLBACK_RECONSTRUCTION_MISMATCH", "rollback bytes do not match signed pre-state")
    executor.atomic_replace_env(
        args.env_file,
        args.plan_record["targetEnvFingerprint"],
        rollback_raw,
        args.plan_record["currentEnvFingerprint"],
    )
    rollback_valid, rollback_sha, _ = executor.runtime_attestation(args.runtime_checker, rollback_raw, "DISABLED")
    if not rollback_valid:
        fail("LIVE_HANDOFF_ROLLBACK_RUNTIME_FAILED", "rollback bytes restored but DISABLED policy attestation failed")
    verified = executor.marker_record(
        "ROLLBACK_VERIFIED",
        binding,
        runtime_sha=rollback_sha,
        recorded_at=args.recorded_at,
    )
    executor.persist_marker(rollback_verified_path, verified, key)
    return {
        "mode": "BACKUP_PRIVACY_LIVE_HANDOFF",
        "status": "ROLLED_BACK",
        "activationId": binding["activationId"],
        "executionId": binding["executionId"],
        "planFingerprint": binding["planFingerprint"],
        "runtimeAttestationSha256": rollback_sha,
        "runtimeConfigurationChanged": False,
        "activationExecuted": False,
        "liveRuntimeAttested": False,
    }, 1


def stage(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    executor = load_executor(args.executor)
    key = executor.read_key(args.key_file)
    verified = executor.verify_plan(args.plan_checker, args.plan, args.key_file)
    plan = executor.read_plan(args.plan, verified, args.env_file)
    directory = executor.safe_execution_dir(args.pending, plan["activationId"])
    args.plan_record = plan

    lock_path = directory / "activation-executor.lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(lock_fd, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(lock_fd)
        raise ValueError("LIVE_HANDOFF_BUSY: activation executor lock is already held") from exc

    try:
        assessment = executor.verify_pending(
            args.evidence_checker,
            args.plan_checker,
            args.plan,
            args.key_file,
            args.env_file,
            args.pending,
        )
        if assessment.get("activationId") != plan["activationId"] or assessment.get("planFingerprint") != plan["planFingerprint"]:
            fail("LIVE_HANDOFF_PENDING_MISMATCH", "PENDING evidence does not match activation plan")
        binding = executor.marker_binding(plan, assessment, args.pending)
        completed, rollback_started, rollback_verified = terminal_markers(executor, directory, binding, key)
        if completed is not None:
            fail("LIVE_HANDOFF_ALREADY_COMPLETED", "terminal file-activation completion already exists")
        if rollback_started is not None or rollback_verified is not None:
            fail("LIVE_HANDOFF_ROLLBACK_CONFLICT", "activation is already in rollback direction")

        handoff_path = directory / HANDOFF_FILE
        existing = read_handoff(handoff_path, binding, key, executor)
        raw = executor.read_regular_bytes(args.env_file, "ENV_FILE")
        actual = executor.sha256_bytes(raw)
        if existing is not None:
            if actual != plan["targetEnvFingerprint"]:
                fail("LIVE_HANDOFF_ENV_DRIFT", "existing handoff no longer matches signed target env")
            return {
                "mode": "BACKUP_PRIVACY_LIVE_HANDOFF",
                "status": "ALREADY_AWAITING_LIVE_RUNTIME_CUTOVER",
                "activationId": binding["activationId"],
                "executionId": binding["executionId"],
                "planFingerprint": binding["planFingerprint"],
                "handoffPath": str(handoff_path),
                "handoffFingerprint": existing["record"]["handoffFingerprint"],
                "handoffSignature": existing["signature"],
                "runtimeConfigurationChanged": True,
                "activationExecuted": False,
                "liveRuntimeAttested": False,
                "envMutationPerformed": False,
            }, 0

        env_mutated = False
        if actual == plan["currentEnvFingerprint"]:
            planner = executor.load_planner(args.planner)
            target_raw, _, rollback = planner.build_reversible_target_env(raw)
            if rollback != plan["rollbackDescriptor"]:
                fail("LIVE_HANDOFF_ROLLBACK_DESCRIPTOR_MISMATCH", "planner reconstruction differs from signed rollback descriptor")
            if executor.sha256_bytes(target_raw) != plan["targetEnvFingerprint"]:
                fail("LIVE_HANDOFF_TARGET_RECONSTRUCTION_MISMATCH", "target bytes do not match signed target fingerprint")
            executor.atomic_replace_env(
                args.env_file,
                plan["currentEnvFingerprint"],
                target_raw,
                plan["targetEnvFingerprint"],
            )
            raw = target_raw
            env_mutated = True
        elif actual == plan["targetEnvFingerprint"]:
            raw = executor.read_regular_bytes(args.env_file, "ENV_FILE")
        else:
            fail("ENV_FINGERPRINT_DRIFT", "env matches neither signed pre-state nor target state")

        valid, runtime_sha, runtime_result = executor.runtime_attestation(args.runtime_checker, raw, "ENABLED")
        if expected_boundary(valid, runtime_result):
            record = make_record(binding, runtime_sha, args.recorded_at or executor.canonical_now(), executor)
            envelope, created = persist_handoff(handoff_path, record, key, binding, executor)
            return {
                "mode": "BACKUP_PRIVACY_LIVE_HANDOFF",
                "status": "AWAITING_LIVE_RUNTIME_CUTOVER",
                "activationId": binding["activationId"],
                "executionId": binding["executionId"],
                "planFingerprint": binding["planFingerprint"],
                "handoffPath": str(handoff_path),
                "handoffFingerprint": envelope["record"]["handoffFingerprint"],
                "handoffSignature": envelope["signature"],
                "handoffCreated": created,
                "runtimeConfigurationChanged": True,
                "activationExecuted": False,
                "liveRuntimeAttested": False,
                "envMutationPerformed": env_mutated,
            }, 0

        return rollback_unexpected_failure(executor, args, directory, binding, key, raw, runtime_sha)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--executor", type=Path, default=root / "infra/backup/execute-backup-privacy-activation.py")
    parser.add_argument("--plan-checker", type=Path, default=root / "infra/backup/check-backup-privacy-activation-plan.py")
    parser.add_argument("--evidence-checker", type=Path, default=root / "infra/backup/backup-privacy-activation-execution.py")
    parser.add_argument("--planner", type=Path, default=root / "infra/backup/prepare-backup-privacy-activation-plan.py")
    parser.add_argument("--runtime-checker", type=Path, default=root / "infra/backup/check-backup-privacy-runtime.sh")
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--pending", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--recorded-at")
    args = parser.parse_args()
    try:
        result, code = stage(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return code
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_LIVE_HANDOFF",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "runtimeConfigurationChanged": False,
            "activationExecuted": False,
            "liveRuntimeAttested": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
