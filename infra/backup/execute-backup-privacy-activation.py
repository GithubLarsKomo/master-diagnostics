#!/usr/bin/env python3
"""Bounded crash/retry-safe executor for signed backup-privacy activation plans.

This mutates exactly the plan-bound .env file. It does not invoke Docker or
restart services. A later host cutover must attest the live processes.
"""
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
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-activation-executor:v1\n"
MARKER_VERSION = 1
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
PLAIN_ENV = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
ROLLBACK_STRATEGY = "REVERSE_ONLY_BOUND_BACKUP_PRIVACY_LINES_V1"

PRIVACY_ENV_KEYS = (
    "PRIVACY_BACKUP_STATE",
    "PRIVACY_BACKUP_POLICY_VERSION",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION",
    "PRIVACY_NOTIFICATIONS_STATE",
    "PRIVACY_NOTIFICATIONS_POLICY_VERSION",
    "PRIVACY_NOTIFICATIONS_SUBJECT_SCOPED_PAYLOAD",
    "PRIVACY_NOTIFICATIONS_DIRECT_IDENTIFIERS_FORBIDDEN",
    "PRIVACY_NOTIFICATIONS_SUBJECT_CLEANUP_SUPPORTED",
)
TARGET_KEYS = PRIVACY_ENV_KEYS[:5]

MARKER_FILES = {
    "ROLLBACK_STARTED": "activation-execution-rollback-started.json",
    "ROLLBACK_VERIFIED": "activation-execution-rollback-verified.json",
    "COMPLETED": "activation-execution-completed.json",
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_timestamp(value: str) -> None:
    if not CANONICAL_UTC.fullmatch(value):
        fail("ACTIVATION_EXECUTOR_TIMESTAMP_INVALID", "timestamp must use canonical UTC milliseconds")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("ACTIVATION_EXECUTOR_TIMESTAMP_INVALID: invalid timestamp") from exc


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_EXECUTOR_KEY_UNSAFE", "key must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("ACTIVATION_EXECUTOR_KEY_PERMISSIONS_UNSAFE", "key must not be group/world writable")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ACTIVATION_EXECUTOR_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("ACTIVATION_EXECUTOR_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def read_regular_bytes(path: Path, label: str) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{label}_UNSAFE", f"{label.lower()} must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail(f"{label}_PERMISSIONS_UNSAFE", f"{label.lower()} must not be group/world writable")
    return path.read_bytes()


def run_json(command: list[str], *, env: dict[str, str] | None = None, cwd: Path | None = None) -> tuple[int, dict[str, Any], bytes]:
    proc = subprocess.run(command, check=False, capture_output=True, env=env, cwd=cwd)
    raw = proc.stdout
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("ACTIVATION_EXECUTOR_JSON_OUTPUT_INVALID: checker did not return one JSON document") from exc
    if not isinstance(payload, dict):
        fail("ACTIVATION_EXECUTOR_JSON_OUTPUT_INVALID", "checker output must be a JSON object")
    return proc.returncode, payload, raw


def verify_plan(checker: Path, plan: Path, key_file: Path) -> dict[str, Any]:
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("ACTIVATION_PLAN_CHECKER_UNSAFE", "plan checker must be an absolute regular non-symlink file")
    code, result, _ = run_json([sys.executable, str(checker), "--plan", str(plan), "--key-file", str(key_file)])
    if code != 0 or result.get("status") != "ACTIVATION_PLAN_VERIFIED":
        fail("ACTIVATION_PLAN_NOT_VERIFIED", f"plan verification failed: {result.get('blocker')}")
    if result.get("activationPlanVersion") != 2 or result.get("activationExecutionAllowed") is not True:
        fail("ACTIVATION_PLAN_NOT_EXECUTABLE", "verified plan is not executable plan v2")
    return result


def read_plan(path: Path, verified: dict[str, Any], env_file: Path) -> dict[str, Any]:
    raw = read_regular_bytes(path, "ACTIVATION_PLAN_FILE")
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_PLAN_INVALID: plan is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("ACTIVATION_PLAN_INVALID", "plan envelope is invalid")
    record = envelope["record"]
    activation_id = record.get("activationId")
    if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
        fail("ACTIVATION_ID_INVALID", "activation ID is invalid")
    if verified.get("activationId") != activation_id or verified.get("planFingerprint") != record.get("planFingerprint"):
        fail("ACTIVATION_PLAN_BINDING_MISMATCH", "plan checker output does not match plan record")
    if record.get("activationPlanVersion") != 2 or record.get("envFilePath") != str(env_file):
        fail("ACTIVATION_PLAN_ENV_BINDING_MISMATCH", "plan is not bound to the requested env file")
    for field in ("currentEnvFingerprint", "targetEnvFingerprint", "planFingerprint"):
        if not isinstance(record.get(field), str) or not SHA256.fullmatch(record[field]):
            fail("ACTIVATION_PLAN_FINGERPRINT_INVALID", f"{field} is invalid")
    for field in (
        "atomicReplaceRequired",
        "postWriteRuntimeAttestationRequired",
        "rollbackOnValidationFailureRequired",
        "exactRollbackReconstructionRequired",
        "nonTargetEnvBytesMustRemainUnchanged",
    ):
        if record.get(field) is not True:
            fail("ACTIVATION_PLAN_POLICY_INVALID", f"{field} must be true")
    rollback = record.get("rollbackDescriptor")
    if not isinstance(rollback, dict) or rollback.get("strategy") != ROLLBACK_STRATEGY:
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "plan lacks the v1 exact rollback descriptor")
    return record


def verify_pending(evidence_checker: Path, plan_checker: Path, plan: Path, key_file: Path, env_file: Path, pending: Path) -> dict[str, Any]:
    if not evidence_checker.is_absolute() or evidence_checker.is_symlink() or not evidence_checker.is_file():
        fail("ACTIVATION_EXECUTION_CHECKER_UNSAFE", "execution evidence checker is unsafe")
    code, result, _ = run_json([
        sys.executable, str(evidence_checker), "check",
        "--plan-checker", str(plan_checker), "--plan", str(plan),
        "--key-file", str(key_file), "--env-file", str(env_file),
        "--execution", str(pending),
    ])
    if code != 0 or result.get("status") not in {"READY_TO_APPLY", "READY_TO_VALIDATE"}:
        fail("ACTIVATION_EXECUTION_NOT_READY", f"execution evidence assessment failed: {result.get('blocker')}")
    return result


def load_planner(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_PLANNER_UNSAFE", "activation planner must be an absolute regular non-symlink file")
    spec = importlib.util.spec_from_file_location("backup_privacy_activation_planner", path)
    if spec is None or spec.loader is None:
        fail("ACTIVATION_PLANNER_INVALID", "could not load activation planner")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "build_reversible_target_env", None)):
        fail("ACTIVATION_PLANNER_INVALID", "planner does not expose build_reversible_target_env")
    return module


def split_line(line: str) -> tuple[str, str]:
    if line.endswith("\r\n"):
        return line[:-2], "\r\n"
    if line.endswith("\n"):
        return line[:-1], "\n"
    if line.endswith("\r"):
        fail("ENV_LINE_ENDING_UNSUPPORTED", "CR-only line ending is unsupported")
    return line, ""


def reconstruct_rollback(target_raw: bytes, descriptor: dict[str, Any]) -> bytes:
    if descriptor.get("strategy") != ROLLBACK_STRATEGY:
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback strategy mismatch")
    try:
        text = target_raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("ENV_FILE_ENCODING_INVALID: target env is not UTF-8") from exc
    lines = text.splitlines(keepends=True)
    patches = descriptor.get("patches")
    if not isinstance(patches, list) or len(patches) != len(TARGET_KEYS):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patches must contain exactly five target variables")
    seen: set[str] = set()
    removals: list[int] = []
    for patch in patches:
        if not isinstance(patch, dict):
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patch is invalid")
        key = patch.get("key")
        if key not in TARGET_KEYS or key in seen:
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patch key set is invalid")
        seen.add(key)
        present = patch.get("originalPresent")
        if present is True:
            index = patch.get("originalLineIndex")
            value = patch.get("originalValue")
            ending = patch.get("originalLineEnding")
            if not isinstance(index, int) or index < 0 or index >= len(lines) or not isinstance(value, str) or ending not in {"LF", "CRLF", "NONE"}:
                fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"rollback metadata for {key} is invalid")
            body, _ = split_line(lines[index])
            match = PLAIN_ENV.fullmatch(body)
            if not match or match.group(1) != key or match.group(2) != patch.get("targetValue"):
                fail("ACTIVATION_ROLLBACK_TARGET_MISMATCH", f"target line for {key} does not match signed descriptor")
            eol = {"LF": "\n", "CRLF": "\r\n", "NONE": ""}[ending]
            lines[index] = f"{key}={value}{eol}"
        elif present is False:
            index = patch.get("targetAppendedLineIndex")
            if not isinstance(index, int) or index < 0 or index >= len(lines):
                fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"appended line index for {key} is invalid")
            body, _ = split_line(lines[index])
            match = PLAIN_ENV.fullmatch(body)
            if not match or match.group(1) != key or match.group(2) != patch.get("targetValue"):
                fail("ACTIVATION_ROLLBACK_TARGET_MISMATCH", f"appended target line for {key} does not match signed descriptor")
            removals.append(index)
        else:
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"originalPresent for {key} is invalid")
    if seen != set(TARGET_KEYS):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback descriptor key set is incomplete")
    for index in sorted(removals, reverse=True):
        del lines[index]
    if descriptor.get("originalHadTrailingLineEnding") is False and lines:
        body, _ = split_line(lines[-1])
        lines[-1] = body
    elif descriptor.get("originalHadTrailingLineEnding") is not True:
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "original trailing-line-ending flag is invalid")
    return "".join(lines).encode("utf-8")


def parse_privacy_environment(raw: bytes) -> dict[str, str]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("ENV_FILE_ENCODING_INVALID: env file must be UTF-8") from exc
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        match = PLAIN_ENV.fullmatch(raw_line)
        if not match:
            for key in PRIVACY_ENV_KEYS:
                if raw_line.lstrip().startswith(key):
                    fail("PRIVACY_ENV_LINE_INVALID", f"{key} must use plain KEY=VALUE syntax")
            continue
        key, value = match.group(1), match.group(2)
        if key not in PRIVACY_ENV_KEYS:
            continue
        if key in values:
            fail("PRIVACY_ENV_DUPLICATE", f"{key} occurs more than once")
        values[key] = value
    return values


def checker_command(path: Path) -> list[str]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("RUNTIME_CHECKER_UNSAFE", "runtime checker must be an absolute regular non-symlink file")
    if path.suffix == ".py":
        return [sys.executable, str(path)]
    if path.suffix == ".sh":
        return ["bash", str(path)]
    return [str(path)]


def runtime_attestation(checker: Path, raw: bytes, expected_backup_state: str) -> tuple[bool, str, dict[str, Any]]:
    privacy = parse_privacy_environment(raw)
    child_env = dict(os.environ)
    for key in PRIVACY_ENV_KEYS:
        child_env.pop(key, None)
    child_env.update(privacy)
    code, result, stdout = run_json(checker_command(checker), env=child_env)
    digest = sha256_bytes(stdout)
    valid = (
        code == 0
        and result.get("readyForIrreversibleProcessing") is True
        and result.get("backupState") == expected_backup_state
        and result.get("blockers") == []
        and (expected_backup_state != "ENABLED" or result.get("backupPolicyVersion") == "1.0.0")
    )
    return valid, digest, result


def safe_execution_dir(pending: Path, activation_id: str) -> Path:
    if not pending.is_absolute() or pending.is_symlink() or not pending.is_file():
        fail("ACTIVATION_EXECUTION_FILE_UNSAFE", "PENDING evidence must be an absolute regular file")
    directory = pending.parent
    if directory.name != activation_id or directory.is_symlink() or not directory.is_dir():
        fail("ACTIVATION_EXECUTION_DIR_BINDING_MISMATCH", "PENDING evidence directory does not match activation ID")
    if stat.S_IMODE(directory.stat().st_mode) & 0o077:
        fail("ACTIVATION_EXECUTION_DIR_PERMISSIONS_UNSAFE", "execution directory must be private")
    return directory


def marker_binding(plan: dict[str, Any], assessment: dict[str, Any], pending: Path) -> dict[str, Any]:
    execution_id = assessment.get("executionId")
    execution_fp = assessment.get("executionFingerprint")
    if not isinstance(execution_id, str) or not isinstance(execution_fp, str) or not SHA256.fullmatch(execution_fp):
        fail("ACTIVATION_EXECUTION_BINDING_INVALID", "execution assessment binding is invalid")
    return {
        "activationId": plan["activationId"],
        "executionId": execution_id,
        "executionFingerprint": execution_fp,
        "pendingEvidenceSha256": sha256_bytes(read_regular_bytes(pending, "ACTIVATION_EXECUTION_FILE")),
        "planFingerprint": plan["planFingerprint"],
        "envFilePath": plan["envFilePath"],
        "currentEnvFingerprint": plan["currentEnvFingerprint"],
        "targetEnvFingerprint": plan["targetEnvFingerprint"],
    }


def sign_marker(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def marker_record(phase: str, binding: dict[str, Any], *, runtime_sha: str | None = None, reason: str | None = None, recorded_at: str | None = None) -> dict[str, Any]:
    if phase not in MARKER_FILES:
        fail("ACTIVATION_EXECUTOR_PHASE_INVALID", "unsupported marker phase")
    timestamp = recorded_at or canonical_now()
    validate_timestamp(timestamp)
    record: dict[str, Any] = {
        "activationExecutorVersion": MARKER_VERSION,
        "phase": phase,
        "recordedAt": timestamp,
        **binding,
        "runtimeAttestationSha256": runtime_sha,
        "failureReasonCode": reason,
        "runtimeConfigurationChanged": phase == "COMPLETED",
        "activationExecuted": phase == "COMPLETED",
        "terminal": phase in {"COMPLETED", "ROLLBACK_VERIFIED"},
    }
    record["markerFingerprint"] = sha256_bytes(canonical_json(record).encode("utf-8"))
    return record


def validate_marker(record: dict[str, Any], phase: str, binding: dict[str, Any]) -> None:
    if record.get("activationExecutorVersion") != MARKER_VERSION or record.get("phase") != phase:
        fail("ACTIVATION_EXECUTOR_MARKER_INVALID", "marker version or phase is invalid")
    validate_timestamp(record.get("recordedAt") if isinstance(record.get("recordedAt"), str) else "")
    for field, expected in binding.items():
        if record.get(field) != expected:
            fail("ACTIVATION_EXECUTOR_MARKER_BINDING_MISMATCH", f"marker field {field} does not match execution binding")
    fingerprint = record.get("markerFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("ACTIVATION_EXECUTOR_MARKER_FINGERPRINT_INVALID", "marker fingerprint is invalid")
    body = dict(record)
    body.pop("markerFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode("utf-8"))):
        fail("ACTIVATION_EXECUTOR_MARKER_FINGERPRINT_MISMATCH", "marker fingerprint does not match")
    runtime_sha = record.get("runtimeAttestationSha256")
    if phase in {"COMPLETED", "ROLLBACK_VERIFIED", "ROLLBACK_STARTED"}:
        if runtime_sha is not None and (not isinstance(runtime_sha, str) or not SHA256.fullmatch(runtime_sha)):
            fail("ACTIVATION_EXECUTOR_RUNTIME_SHA_INVALID", "runtime attestation SHA-256 is invalid")
    if phase == "COMPLETED" and runtime_sha is None:
        fail("ACTIVATION_EXECUTOR_RUNTIME_SHA_REQUIRED", "COMPLETED must bind the successful runtime attestation")
    reason = record.get("failureReasonCode")
    if phase == "ROLLBACK_STARTED":
        if reason != "RUNTIME_ATTESTATION_FAILED":
            fail("ACTIVATION_EXECUTOR_ROLLBACK_REASON_INVALID", "rollback marker has invalid reason")
    elif reason is not None:
        fail("ACTIVATION_EXECUTOR_ROLLBACK_REASON_UNEXPECTED", "failure reason is only allowed on ROLLBACK_STARTED")
    if record.get("runtimeConfigurationChanged") is not (phase == "COMPLETED"):
        fail("ACTIVATION_EXECUTOR_RUNTIME_STATE_INVALID", "runtime configuration flag is invalid")
    if record.get("activationExecuted") is not (phase == "COMPLETED"):
        fail("ACTIVATION_EXECUTOR_COMPLETION_STATE_INVALID", "activationExecuted flag is invalid")
    if record.get("terminal") is not (phase in {"COMPLETED", "ROLLBACK_VERIFIED"}):
        fail("ACTIVATION_EXECUTOR_TERMINAL_STATE_INVALID", "terminal flag is invalid")


def read_marker(path: Path, phase: str, binding: dict[str, Any], key: bytes) -> dict[str, Any] | None:
    if not path.exists():
        return None
    raw = read_regular_bytes(path, "ACTIVATION_EXECUTOR_MARKER")
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_EXECUTOR_MARKER_INVALID: marker is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("ACTIVATION_EXECUTOR_MARKER_INVALID", "marker envelope is invalid")
    record = envelope["record"]
    validate_marker(record, phase, binding)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_EXECUTOR_MARKER_SIGNATURE_INVALID", "marker signature is invalid")
    if not hmac.compare_digest(signature, sign_marker(record, key)):
        fail("ACTIVATION_EXECUTOR_MARKER_SIGNATURE_MISMATCH", "marker HMAC does not match")
    return envelope


def persist_marker(path: Path, record: dict[str, Any], key: bytes) -> dict[str, Any]:
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_marker(record, key)}
    serialized = (json.dumps(envelope, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if path.exists():
        existing = read_marker(path, record["phase"], {k: record[k] for k in (
            "activationId", "executionId", "executionFingerprint", "pendingEvidenceSha256", "planFingerprint",
            "envFilePath", "currentEnvFingerprint", "targetEnvFingerprint",
        )}, key)
        if existing != envelope:
            fail("ACTIVATION_EXECUTOR_MARKER_CONFLICT", f"existing {record['phase']} marker differs")
        return envelope
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
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return envelope


def atomic_replace_env(path: Path, before_fingerprint: str, new_raw: bytes, after_fingerprint: str) -> None:
    current = read_regular_bytes(path, "ENV_FILE")
    if sha256_bytes(current) != before_fingerprint:
        fail("ENV_FINGERPRINT_CHANGED_BEFORE_REPLACE", "env changed before bounded atomic replace")
    if sha256_bytes(new_raw) != after_fingerprint:
        fail("ACTIVATION_REPLACEMENT_FINGERPRINT_INVALID", "replacement bytes do not match signed target fingerprint")
    metadata = path.stat()
    if os.geteuid() != 0 and metadata.st_uid != os.geteuid():
        fail("ENV_FILE_OWNER_UNSAFE", "non-root executor must own the env file")
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.backup-privacy-", suffix=".tmp", dir=path.parent)
    temp = Path(temp_name)
    try:
        os.fchmod(fd, stat.S_IMODE(metadata.st_mode))
        if os.geteuid() == 0:
            os.fchown(fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(fd, "wb", closefd=True) as handle:
            handle.write(new_raw)
            handle.flush()
            os.fsync(handle.fileno())
        if sha256_bytes(read_regular_bytes(path, "ENV_FILE")) != before_fingerprint:
            fail("ENV_FINGERPRINT_CHANGED_BEFORE_REPLACE", "env changed during replacement preparation")
        os.replace(temp, path)
        parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        if sha256_bytes(read_regular_bytes(path, "ENV_FILE")) != after_fingerprint:
            fail("ENV_REPLACE_VERIFICATION_FAILED", "env fingerprint after replace does not match expectation")
    finally:
        temp.unlink(missing_ok=True)


def output(status: str, binding: dict[str, Any], *, runtime_sha: str | None = None, blocker: str | None = None) -> dict[str, Any]:
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_BOUNDED_EXECUTOR",
        "status": status,
        "activationId": binding.get("activationId"),
        "executionId": binding.get("executionId"),
        "planFingerprint": binding.get("planFingerprint"),
        "runtimeAttestationSha256": runtime_sha,
        "blocker": blocker,
        "runtimeConfigurationChanged": status in {"COMPLETED", "ALREADY_COMPLETED"},
        "activationExecuted": status in {"COMPLETED", "ALREADY_COMPLETED"},
    }


def execute(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    key = read_key(args.key_file)
    verified = verify_plan(args.plan_checker, args.plan, args.key_file)
    plan = read_plan(args.plan, verified, args.env_file)
    directory = safe_execution_dir(args.pending, plan["activationId"])

    lock_path = directory / "activation-executor.lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(lock_fd, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(lock_fd)
        raise ValueError("ACTIVATION_EXECUTOR_BUSY: another executor holds the activation lock") from exc

    try:
        assessment = verify_pending(args.evidence_checker, args.plan_checker, args.plan, args.key_file, args.env_file, args.pending)
        if assessment.get("activationId") != plan["activationId"] or assessment.get("planFingerprint") != plan["planFingerprint"]:
            fail("ACTIVATION_EXECUTION_BINDING_MISMATCH", "PENDING evidence does not match plan")
        binding = marker_binding(plan, assessment, args.pending)
        paths = {phase: directory / filename for phase, filename in MARKER_FILES.items()}
        completed = read_marker(paths["COMPLETED"], "COMPLETED", binding, key)
        rollback_started = read_marker(paths["ROLLBACK_STARTED"], "ROLLBACK_STARTED", binding, key)
        rollback_verified = read_marker(paths["ROLLBACK_VERIFIED"], "ROLLBACK_VERIFIED", binding, key)
        if completed is not None and (rollback_started is not None or rollback_verified is not None):
            fail("ACTIVATION_EXECUTOR_STATE_CONFLICT", "completion and rollback evidence cannot coexist")
        if rollback_verified is not None and rollback_started is None:
            fail("ACTIVATION_EXECUTOR_STATE_CONFLICT", "ROLLBACK_VERIFIED requires ROLLBACK_STARTED")

        raw = read_regular_bytes(args.env_file, "ENV_FILE")
        actual = sha256_bytes(raw)
        if completed is not None:
            if actual != plan["targetEnvFingerprint"]:
                fail("ACTIVATION_EXECUTOR_COMPLETED_ENV_DRIFT", "completed activation no longer matches target env fingerprint")
            return output("ALREADY_COMPLETED", binding, runtime_sha=completed["record"]["runtimeAttestationSha256"]), 0
        if rollback_verified is not None:
            if actual != plan["currentEnvFingerprint"]:
                fail("ACTIVATION_EXECUTOR_ROLLBACK_ENV_DRIFT", "verified rollback no longer matches original env fingerprint")
            return output("ALREADY_ROLLED_BACK", binding, runtime_sha=rollback_verified["record"].get("runtimeAttestationSha256")), 1

        if rollback_started is not None:
            if actual == plan["targetEnvFingerprint"]:
                rollback_raw = reconstruct_rollback(raw, plan["rollbackDescriptor"])
                if sha256_bytes(rollback_raw) != plan["currentEnvFingerprint"]:
                    fail("ACTIVATION_ROLLBACK_RECONSTRUCTION_MISMATCH", "rollback bytes do not match signed pre-state")
                atomic_replace_env(args.env_file, plan["targetEnvFingerprint"], rollback_raw, plan["currentEnvFingerprint"])
                raw = rollback_raw
            elif actual == plan["currentEnvFingerprint"]:
                raw = read_regular_bytes(args.env_file, "ENV_FILE")
            else:
                fail("ENV_FINGERPRINT_DRIFT", "rollback recovery env matches neither signed target nor original state")
            valid, runtime_sha, _ = runtime_attestation(args.runtime_checker, raw, "DISABLED")
            if not valid:
                fail("ROLLBACK_RUNTIME_ATTESTATION_FAILED", "rollback bytes restored but runtime policy attestation did not verify DISABLED state")
            record = marker_record("ROLLBACK_VERIFIED", binding, runtime_sha=runtime_sha, recorded_at=args.recorded_at)
            persist_marker(paths["ROLLBACK_VERIFIED"], record, key)
            return output("ROLLED_BACK", binding, runtime_sha=runtime_sha), 1

        if actual == plan["currentEnvFingerprint"]:
            planner = load_planner(args.planner)
            target_raw, _, rollback = planner.build_reversible_target_env(raw)
            if rollback != plan["rollbackDescriptor"]:
                fail("ACTIVATION_PLAN_ROLLBACK_RECONSTRUCTION_MISMATCH", "planner reconstruction differs from signed rollback descriptor")
            if sha256_bytes(target_raw) != plan["targetEnvFingerprint"]:
                fail("ACTIVATION_TARGET_RECONSTRUCTION_MISMATCH", "reconstructed target does not match signed target fingerprint")
            atomic_replace_env(args.env_file, plan["currentEnvFingerprint"], target_raw, plan["targetEnvFingerprint"])
            raw = target_raw
        elif actual == plan["targetEnvFingerprint"]:
            raw = read_regular_bytes(args.env_file, "ENV_FILE")
        else:
            fail("ENV_FINGERPRINT_DRIFT", "env matches neither signed pre-state nor target state")

        valid, runtime_sha, _ = runtime_attestation(args.runtime_checker, raw, "ENABLED")
        if valid:
            record = marker_record("COMPLETED", binding, runtime_sha=runtime_sha, recorded_at=args.recorded_at)
            persist_marker(paths["COMPLETED"], record, key)
            return output("COMPLETED", binding, runtime_sha=runtime_sha), 0

        rollback_started_record = marker_record(
            "ROLLBACK_STARTED", binding, runtime_sha=runtime_sha,
            reason="RUNTIME_ATTESTATION_FAILED", recorded_at=args.recorded_at,
        )
        persist_marker(paths["ROLLBACK_STARTED"], rollback_started_record, key)
        rollback_raw = reconstruct_rollback(raw, plan["rollbackDescriptor"])
        if sha256_bytes(rollback_raw) != plan["currentEnvFingerprint"]:
            fail("ACTIVATION_ROLLBACK_RECONSTRUCTION_MISMATCH", "rollback bytes do not match signed pre-state")
        atomic_replace_env(args.env_file, plan["targetEnvFingerprint"], rollback_raw, plan["currentEnvFingerprint"])
        rollback_valid, rollback_sha, _ = runtime_attestation(args.runtime_checker, rollback_raw, "DISABLED")
        if not rollback_valid:
            fail("ROLLBACK_RUNTIME_ATTESTATION_FAILED", "rollback bytes restored but DISABLED runtime policy attestation failed")
        verified_record = marker_record("ROLLBACK_VERIFIED", binding, runtime_sha=rollback_sha, recorded_at=args.recorded_at)
        persist_marker(paths["ROLLBACK_VERIFIED"], verified_record, key)
        return output("ROLLED_BACK", binding, runtime_sha=rollback_sha), 1
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
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
    if args.recorded_at is not None:
        validate_timestamp(args.recorded_at)
    try:
        result, code = execute(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return code
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_BOUNDED_EXECUTOR",
            "status": "BLOCKED",
            "blocker": blocker,
            "runtimeConfigurationChanged": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
