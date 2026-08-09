#!/usr/bin/env python3
"""Prepare and assess signed pre-mutation evidence for backup-privacy activation execution."""
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EXECUTION_VERSION = 1
ENVELOPE_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-activation-execution:v1\n"
PENDING_FILE = "activation-execution-pending.json"
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
EXECUTION_ID = re.compile(r"^execution-[0-9a-f]{32}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
ROLLBACK_STRATEGY = "REVERSE_ONLY_BOUND_BACKUP_PRIVACY_LINES_V1"


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_EXECUTION_KEY_UNSAFE", "key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ACTIVATION_EXECUTION_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("ACTIVATION_EXECUTION_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def read_env(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ENV_FILE_UNSAFE", "env file must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("ENV_FILE_PERMISSIONS_UNSAFE", "env file must not be group/world writable")
    return path.read_bytes()


def verify_plan(checker: Path, plan: Path, key_file: Path) -> dict[str, Any]:
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("ACTIVATION_PLAN_CHECKER_UNSAFE", "plan checker must be an absolute regular non-symlink file")
    proc = subprocess.run(
        [sys.executable, str(checker), "--plan", str(plan), "--key-file", str(key_file)],
        check=False,
        capture_output=True,
        text=True,
    )
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_PLAN_CHECK_OUTPUT_INVALID: plan checker did not return JSON") from exc
    if proc.returncode != 0 or result.get("status") != "ACTIVATION_PLAN_VERIFIED":
        fail("ACTIVATION_PLAN_NOT_VERIFIED", f"activation plan verification failed: {result.get('blocker')}")
    if result.get("activationPlanVersion") != 2 or result.get("activationExecutionAllowed") is not True:
        fail("ACTIVATION_PLAN_NOT_AUTHORIZING", "verified plan does not authorize execution")
    if result.get("runtimeConfigurationChanged") is not False or result.get("activationExecuted") is not False:
        fail("ACTIVATION_PLAN_BOUNDARY_INVALID", "activation plan must remain pre-mutation evidence")
    return result


def read_plan_envelope(path: Path) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_PLAN_FILE_UNSAFE", "plan must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("ACTIVATION_PLAN_PERMISSIONS_UNSAFE", "plan must be private")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("envelopeVersion") != 1:
        fail("ACTIVATION_PLAN_INVALID", "plan envelope is invalid")
    if not isinstance(raw.get("record"), dict) or not isinstance(raw.get("signature"), str):
        fail("ACTIVATION_PLAN_INVALID", "plan record or signature is missing")
    return raw


def plan_binding(plan: dict[str, Any], verified: dict[str, Any], plan_path: Path, env_path: Path) -> dict[str, Any]:
    record = plan["record"]
    signature = plan["signature"]
    activation_id = record.get("activationId")
    if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
        fail("ACTIVATION_ID_INVALID", "activation ID is invalid")
    if verified.get("activationId") != activation_id or verified.get("planFingerprint") != record.get("planFingerprint"):
        fail("ACTIVATION_PLAN_VERIFICATION_MISMATCH", "checker output does not match plan record")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_PLAN_SIGNATURE_INVALID", "plan signature is invalid")
    if record.get("envFilePath") != str(env_path) or verified.get("envFilePath") != str(env_path):
        fail("ACTIVATION_ENV_PATH_MISMATCH", "execution env path does not match signed activation plan")
    for field in ("planFingerprint", "currentEnvFingerprint", "targetEnvFingerprint"):
        value = record.get(field)
        if not isinstance(value, str) or not SHA256.fullmatch(value):
            fail("ACTIVATION_PLAN_FINGERPRINT_INVALID", f"{field} is invalid")
    rollback = record.get("rollbackDescriptor")
    if not isinstance(rollback, dict) or rollback.get("strategy") != ROLLBACK_STRATEGY:
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "signed plan lacks reversible rollback descriptor")
    for field in (
        "atomicReplaceRequired",
        "postWriteRuntimeAttestationRequired",
        "rollbackOnValidationFailureRequired",
        "exactRollbackReconstructionRequired",
        "nonTargetEnvBytesMustRemainUnchanged",
    ):
        if record.get(field) is not True:
            fail("ACTIVATION_PLAN_POLICY_INVALID", f"{field} must be true")
    return {
        "activationId": activation_id,
        "planFingerprint": record["planFingerprint"],
        "planSignature": signature,
        "planFileSha256": sha256_bytes(plan_path.read_bytes()),
        "envFilePath": str(env_path),
        "currentEnvFingerprint": record["currentEnvFingerprint"],
        "targetEnvFingerprint": record["targetEnvFingerprint"],
        "rollbackStrategy": ROLLBACK_STRATEGY,
    }


def expected_execution_id(binding: dict[str, Any]) -> str:
    identity = {
        "activationId": binding["activationId"],
        "planFingerprint": binding["planFingerprint"],
        "planSignature": binding["planSignature"],
        "planFileSha256": binding["planFileSha256"],
        "envFilePath": binding["envFilePath"],
        "currentEnvFingerprint": binding["currentEnvFingerprint"],
        "targetEnvFingerprint": binding["targetEnvFingerprint"],
    }
    return "execution-" + hashlib.sha256(canonical_json(identity).encode()).hexdigest()[:32]


def safe_output_root(path: Path) -> None:
    if not path.is_absolute():
        fail("ACTIVATION_EXECUTION_OUTPUT_NOT_ABSOLUTE", "execution output root must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("ACTIVATION_EXECUTION_OUTPUT_UNSAFE", "execution output root must be a non-symlink directory")
    os.chmod(path, 0o700)


def safe_execution_dir(output_root: Path, activation_id: str, create: bool) -> Path:
    path = output_root / activation_id
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
        if path.is_symlink() or not path.is_dir():
            fail("ACTIVATION_EXECUTION_DIR_UNSAFE", "execution directory must be a non-symlink directory")
        os.chmod(path, 0o700)
    else:
        if not path.is_absolute() or path.is_symlink() or not path.is_dir():
            fail("ACTIVATION_EXECUTION_DIR_UNSAFE", "execution directory is missing or unsafe")
        if stat.S_IMODE(path.stat().st_mode) & 0o077:
            fail("ACTIVATION_EXECUTION_DIR_PERMISSIONS_UNSAFE", "execution directory must be private")
    return path


def make_record(binding: dict[str, Any], started_at: str) -> dict[str, Any]:
    if not CANONICAL_UTC.fullmatch(started_at) or not isinstance(datetime.fromisoformat(started_at.replace("Z", "+00:00")), datetime):
        fail("ACTIVATION_EXECUTION_TIMESTAMP_INVALID", "startedAt must be canonical UTC ISO-8601")
    record: dict[str, Any] = {
        "activationExecutionVersion": EXECUTION_VERSION,
        "phase": "PENDING",
        "executionId": expected_execution_id(binding),
        "startedAt": started_at,
        **binding,
        "pendingEvidenceRequiredBeforeMutation": True,
        "atomicReplaceRequired": True,
        "postWriteRuntimeAttestationRequired": True,
        "rollbackOnValidationFailureRequired": True,
        "exactRollbackReconstructionRequired": True,
        "nonTargetEnvBytesMustRemainUnchanged": True,
        "executionMutationStarted": False,
        "runtimeConfigurationChanged": False,
        "activationExecuted": False,
    }
    record["executionFingerprint"] = "sha256:" + hashlib.sha256(canonical_json(record).encode()).hexdigest()
    return record


def validate_record(record: dict[str, Any], binding: dict[str, Any]) -> None:
    if record.get("activationExecutionVersion") != EXECUTION_VERSION or record.get("phase") != "PENDING":
        fail("ACTIVATION_EXECUTION_VERSION_INVALID", "execution version or phase is invalid")
    execution_id = record.get("executionId")
    if not isinstance(execution_id, str) or not EXECUTION_ID.fullmatch(execution_id) or execution_id != expected_execution_id(binding):
        fail("ACTIVATION_EXECUTION_ID_INVALID", "execution ID does not match signed plan binding")
    started_at = record.get("startedAt")
    if not isinstance(started_at, str) or not CANONICAL_UTC.fullmatch(started_at):
        fail("ACTIVATION_EXECUTION_TIMESTAMP_INVALID", "startedAt is invalid")
    for key, value in binding.items():
        if record.get(key) != value:
            fail("ACTIVATION_EXECUTION_BINDING_MISMATCH", f"execution evidence does not match {key}")
    for field in (
        "pendingEvidenceRequiredBeforeMutation",
        "atomicReplaceRequired",
        "postWriteRuntimeAttestationRequired",
        "rollbackOnValidationFailureRequired",
        "exactRollbackReconstructionRequired",
        "nonTargetEnvBytesMustRemainUnchanged",
    ):
        if record.get(field) is not True:
            fail("ACTIVATION_EXECUTION_POLICY_INVALID", f"{field} must be true")
    if record.get("executionMutationStarted") is not False or record.get("runtimeConfigurationChanged") is not False or record.get("activationExecuted") is not False:
        fail("ACTIVATION_EXECUTION_BOUNDARY_INVALID", "PENDING execution evidence must be pre-mutation")
    fingerprint = record.get("executionFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("ACTIVATION_EXECUTION_FINGERPRINT_INVALID", "execution fingerprint is invalid")
    body = dict(record)
    body.pop("executionFingerprint")
    expected = "sha256:" + hashlib.sha256(canonical_json(body).encode()).hexdigest()
    if not hmac.compare_digest(fingerprint, expected):
        fail("ACTIVATION_EXECUTION_FINGERPRINT_MISMATCH", "execution fingerprint does not match record")


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": ENVELOPE_VERSION, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode(), hashlib.sha256).hexdigest()


def verify_execution(path: Path, key: bytes, binding: dict[str, Any]) -> dict[str, Any]:
    if not path.is_absolute() or path.name != PENDING_FILE:
        fail("ACTIVATION_EXECUTION_PATH_INVALID", "execution evidence path or filename is invalid")
    if path.is_symlink() or not path.is_file():
        fail("ACTIVATION_EXECUTION_FILE_UNSAFE", "execution evidence must be a regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("ACTIVATION_EXECUTION_PERMISSIONS_UNSAFE", "execution evidence must be private")
    envelope = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != ENVELOPE_VERSION:
        fail("ACTIVATION_EXECUTION_ENVELOPE_INVALID", "execution envelope version is invalid")
    record = envelope.get("record")
    signature = envelope.get("signature")
    if not isinstance(record, dict):
        fail("ACTIVATION_EXECUTION_INVALID", "execution record is missing")
    validate_record(record, binding)
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_EXECUTION_SIGNATURE_INVALID", "execution signature is invalid")
    expected = sign_record(record, key)
    if not hmac.compare_digest(signature, expected):
        fail("ACTIVATION_EXECUTION_SIGNATURE_MISMATCH", "execution HMAC does not match record")
    return envelope


def persist_pending(path: Path, envelope: dict[str, Any]) -> bool:
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    return True


def env_state(actual: str, binding: dict[str, Any]) -> str:
    if hmac.compare_digest(actual, binding["currentEnvFingerprint"]):
        return "PRE_WRITE"
    if hmac.compare_digest(actual, binding["targetEnvFingerprint"]):
        return "POST_WRITE"
    return "DRIFT"


def context(args: argparse.Namespace) -> tuple[dict[str, Any], bytes, dict[str, Any], str]:
    verified = verify_plan(args.plan_checker, args.plan, args.key_file)
    plan = read_plan_envelope(args.plan)
    key = read_key(args.key_file)
    raw = read_env(args.env_file)
    binding = plan_binding(plan, verified, args.plan, args.env_file)
    return binding, key, plan, sha256_bytes(raw)


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    binding, key, _, actual = context(args)
    safe_output_root(args.output_root)
    execution_dir = safe_execution_dir(args.output_root, binding["activationId"], create=True)
    path = execution_dir / PENDING_FILE
    created = False
    if path.exists():
        envelope = verify_execution(path, key, binding)
    else:
        state = env_state(actual, binding)
        if state == "POST_WRITE":
            fail("TARGET_STATE_WITHOUT_EXECUTION_EVIDENCE", "target env fingerprint exists without durable PENDING execution evidence")
        if state == "DRIFT":
            fail("ENV_FINGERPRINT_DRIFT", "env fingerprint matches neither signed pre-state nor target state")
        record = make_record(binding, args.started_at or now_utc())
        envelope = {"envelopeVersion": ENVELOPE_VERSION, "record": record, "signature": sign_record(record, key)}
        created = persist_pending(path, envelope)
        if not created:
            envelope = verify_execution(path, key, binding)
    state = env_state(actual, binding)
    if state == "DRIFT":
        fail("ENV_FINGERPRINT_DRIFT", "env fingerprint matches neither signed pre-state nor target state")
    record = envelope["record"]
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_EXECUTION_EVIDENCE",
        "status": "ACTIVATION_EXECUTION_PENDING",
        "activationId": binding["activationId"],
        "executionId": record["executionId"],
        "executionFingerprint": record["executionFingerprint"],
        "planFingerprint": binding["planFingerprint"],
        "executionPath": str(path),
        "executionCreated": created,
        "executionReused": not created,
        "envState": state,
        "activationMutationAllowed": state == "PRE_WRITE",
        "postWriteValidationRequired": state == "POST_WRITE",
        "runtimeConfigurationChanged": state == "POST_WRITE",
        "activationExecuted": False,
    }


def check(args: argparse.Namespace) -> dict[str, Any]:
    binding, key, _, actual = context(args)
    if args.execution.parent.name != binding["activationId"]:
        fail("ACTIVATION_EXECUTION_PATH_BINDING_MISMATCH", "execution evidence directory does not match activation ID")
    envelope = verify_execution(args.execution, key, binding)
    state = env_state(actual, binding)
    if state == "DRIFT":
        fail("ENV_FINGERPRINT_DRIFT", "env fingerprint matches neither signed pre-state nor target state")
    status = "READY_TO_APPLY" if state == "PRE_WRITE" else "READY_TO_VALIDATE"
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_EXECUTION_ASSESSMENT",
        "status": status,
        "activationId": binding["activationId"],
        "executionId": envelope["record"]["executionId"],
        "executionFingerprint": envelope["record"]["executionFingerprint"],
        "planFingerprint": binding["planFingerprint"],
        "envState": state,
        "activationMutationAllowed": state == "PRE_WRITE",
        "postWriteValidationRequired": state == "POST_WRITE",
        "runtimeConfigurationChanged": state == "POST_WRITE",
        "activationExecuted": False,
    }


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--plan-checker", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    prepare_parser = sub.add_parser("prepare")
    add_common(prepare_parser)
    prepare_parser.add_argument("--output-root", required=True, type=Path)
    prepare_parser.add_argument("--started-at")
    check_parser = sub.add_parser("check")
    add_common(check_parser)
    check_parser.add_argument("--execution", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args) if args.command == "prepare" else check(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_EXECUTION_EVIDENCE",
            "status": "BLOCKED",
            "blocker": blocker,
            "activationMutationAllowed": False,
            "postWriteValidationRequired": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
