#!/usr/bin/env python3
"""Bounded crash/retry-safe atomic executor for backup-privacy env activation."""
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

RECEIPT_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-activation-executor-receipt:v1\n"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
EXECUTION_ID = re.compile(r"^execution-[0-9a-f]{32}$")
PENDING_FILE = "activation-execution-pending.json"
PHASE_FILES = {
    "MUTATION_STARTED": "activation-mutation-started.json",
    "COMPLETED": "activation-completed.json",
    "ROLLBACK_STARTED": "activation-rollback-started.json",
    "ROLLED_BACK": "activation-rolled-back.json",
}
TARGET_ORDER = (
    "PRIVACY_BACKUP_STATE",
    "PRIVACY_BACKUP_POLICY_VERSION",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION",
)
TARGET = {
    "PRIVACY_BACKUP_STATE": "ENABLED",
    "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
}


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


def read_private_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{label}_UNSAFE", f"{label.lower()} must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail(f"{label}_PERMISSIONS_UNSAFE", f"{label.lower()} must be private")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label}_INVALID: invalid JSON") from exc
    if not isinstance(value, dict):
        fail(f"{label}_INVALID", f"{label.lower()} must contain a JSON object")
    return value


def read_env(path: Path) -> tuple[bytes, os.stat_result]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_EXECUTOR_ENV_UNSAFE", "env file must be an absolute regular non-symlink file")
    info = path.stat()
    if stat.S_IMODE(info.st_mode) & 0o022:
        fail("ACTIVATION_EXECUTOR_ENV_PERMISSIONS_UNSAFE", "env file must not be group/world writable")
    return path.read_bytes(), info


def validate_tool(path: Path, label: str) -> None:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{label}_UNSAFE", f"{label.lower()} must be an absolute regular non-symlink file")


def run_json_tool(command: list[str], cwd: Path | None = None) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(command, cwd=cwd, check=False, capture_output=True, text=True)
    stdout = proc.stdout.strip()
    if not stdout:
        return proc.returncode or 1, {"status": "BLOCKED", "blocker": "TOOL_OUTPUT_MISSING"}
    try:
        payload = json.loads(stdout.splitlines()[-1])
    except json.JSONDecodeError:
        return proc.returncode or 1, {"status": "BLOCKED", "blocker": "TOOL_OUTPUT_INVALID"}
    if not isinstance(payload, dict):
        return proc.returncode or 1, {"status": "BLOCKED", "blocker": "TOOL_OUTPUT_INVALID"}
    return proc.returncode, payload


def execution_assessment(args: argparse.Namespace) -> dict[str, Any]:
    code, result = run_json_tool([
        sys.executable,
        str(args.execution_checker),
        "check",
        "--plan-checker", str(args.plan_checker),
        "--plan", str(args.plan),
        "--key-file", str(args.key_file),
        "--env-file", str(args.env_file),
        "--execution", str(args.pending_execution),
    ])
    if code != 0 or result.get("status") not in ("READY_TO_APPLY", "READY_TO_VALIDATE"):
        fail("ACTIVATION_EXECUTION_NOT_READY", f"PENDING execution assessment is not actionable: {result.get('status')}")
    return result


def runtime_attestation(args: argparse.Namespace, expected_state: str) -> tuple[bool, dict[str, Any], str]:
    code, result = run_json_tool([
        sys.executable,
        str(args.runtime_checker),
        "--repo-root", str(args.repo_root),
        "--env-file", str(args.env_file),
        "--expected-backup-state", expected_state,
    ])
    evidence = {
        "status": result.get("status"),
        "blocker": result.get("blocker"),
        "expectedBackupState": result.get("expectedBackupState"),
        "readyForIrreversibleProcessing": result.get("readyForIrreversibleProcessing"),
        "backupState": result.get("backupState"),
        "notificationsState": result.get("notificationsState"),
        "backupPolicyVersion": result.get("backupPolicyVersion"),
        "notificationPolicyVersion": result.get("notificationPolicyVersion"),
        "blockers": result.get("blockers"),
        "attestationFingerprint": result.get("attestationFingerprint"),
    }
    digest = sha256_bytes(canonical_json(evidence).encode("utf-8"))
    ok = code == 0 and result.get("status") == "RUNTIME_PRIVACY_VERIFIED" and result.get("expectedBackupState") == expected_state
    return ok, evidence, digest


def load_context(args: argparse.Namespace) -> dict[str, Any]:
    validate_tool(args.execution_checker, "ACTIVATION_EXECUTION_CHECKER")
    validate_tool(args.plan_checker, "ACTIVATION_PLAN_CHECKER")
    validate_tool(args.runtime_checker, "ACTIVATION_RUNTIME_CHECKER")
    if not args.repo_root.is_absolute() or args.repo_root.is_symlink() or not args.repo_root.is_dir():
        fail("ACTIVATION_REPO_ROOT_UNSAFE", "repo root must be an absolute regular non-symlink directory")
    assessment = execution_assessment(args)
    plan = read_private_json(args.plan, "ACTIVATION_PLAN")
    pending = read_private_json(args.pending_execution, "ACTIVATION_PENDING_EXECUTION")
    record = plan.get("record")
    pending_record = pending.get("record")
    plan_signature = plan.get("signature")
    pending_signature = pending.get("signature")
    if plan.get("envelopeVersion") != 1 or not isinstance(record, dict) or not isinstance(plan_signature, str) or not HMAC_SHA256.fullmatch(plan_signature):
        fail("ACTIVATION_PLAN_INVALID", "activation plan envelope is invalid")
    if pending.get("envelopeVersion") != 1 or not isinstance(pending_record, dict) or not isinstance(pending_signature, str) or not HMAC_SHA256.fullmatch(pending_signature):
        fail("ACTIVATION_PENDING_EXECUTION_INVALID", "PENDING execution envelope is invalid")
    activation_id = record.get("activationId")
    execution_id = pending_record.get("executionId")
    execution_fp = pending_record.get("executionFingerprint")
    if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
        fail("ACTIVATION_ID_INVALID", "activation ID is invalid")
    if not isinstance(execution_id, str) or not EXECUTION_ID.fullmatch(execution_id):
        fail("ACTIVATION_EXECUTION_ID_INVALID", "execution ID is invalid")
    if not isinstance(execution_fp, str) or not SHA256.fullmatch(execution_fp):
        fail("ACTIVATION_EXECUTION_FINGERPRINT_INVALID", "execution fingerprint is invalid")
    if assessment.get("activationId") != activation_id or assessment.get("executionId") != execution_id or assessment.get("executionFingerprint") != execution_fp:
        fail("ACTIVATION_EXECUTION_ASSESSMENT_MISMATCH", "PENDING assessment does not match bound evidence")
    if record.get("envFilePath") != str(args.env_file) or pending_record.get("envFilePath") != str(args.env_file):
        fail("ACTIVATION_ENV_PATH_MISMATCH", "env path does not match signed activation evidence")
    if record.get("activationTarget") != TARGET:
        fail("ACTIVATION_TARGET_INVALID", "activation target does not match backup privacy policy v1")
    for field in ("currentEnvFingerprint", "targetEnvFingerprint", "planFingerprint"):
        value = record.get(field)
        if not isinstance(value, str) or not SHA256.fullmatch(value):
            fail("ACTIVATION_FINGERPRINT_INVALID", f"{field} is invalid")
    rollback = record.get("rollbackDescriptor")
    if not isinstance(rollback, dict) or rollback.get("strategy") != "REVERSE_ONLY_BOUND_BACKUP_PRIVACY_LINES_V1":
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "plan lacks byte-reversible rollback descriptor")
    if args.pending_execution.name != PENDING_FILE or args.pending_execution.parent.name != activation_id:
        fail("ACTIVATION_PENDING_PATH_INVALID", "PENDING execution path does not match activation ID")
    if stat.S_IMODE(args.pending_execution.parent.stat().st_mode) & 0o077:
        fail("ACTIVATION_EXECUTION_DIR_PERMISSIONS_UNSAFE", "execution directory must be private")
    return {
        "assessment": assessment,
        "record": record,
        "pendingRecord": pending_record,
        "pendingSignature": pending_signature,
        "pendingFileSha256": sha256_bytes(args.pending_execution.read_bytes()),
        "activationId": activation_id,
        "executionId": execution_id,
        "executionFingerprint": execution_fp,
        "executionDir": args.pending_execution.parent,
    }


def line_ending_from_name(value: str | None) -> str:
    if value == "LF":
        return "\n"
    if value == "CRLF":
        return "\r\n"
    if value == "NONE":
        return ""
    fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "line ending metadata is invalid")


def split_line(line: str) -> tuple[str, str]:
    if line.endswith("\r\n"):
        return line[:-2], "\r\n"
    if line.endswith("\n"):
        return line[:-1], "\n"
    return line, ""


def reconstruct_target(raw: bytes, record: dict[str, Any]) -> bytes:
    if sha256_bytes(raw) != record["currentEnvFingerprint"]:
        fail("ACTIVATION_PRE_FINGERPRINT_MISMATCH", "target reconstruction requires exact signed pre-state bytes")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("ACTIVATION_ENV_ENCODING_INVALID: env must be UTF-8") from exc
    lines = text.splitlines(keepends=True)
    rollback = record["rollbackDescriptor"]
    patches = rollback.get("patches")
    if not isinstance(patches, list) or len(patches) != len(TARGET_ORDER):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patches are invalid")
    patch_by_key = {item.get("key"): item for item in patches if isinstance(item, dict)}
    if set(patch_by_key) != set(TARGET_ORDER):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patch keys are invalid")
    for key in TARGET_ORDER:
        patch = patch_by_key[key]
        if patch.get("targetValue") != TARGET[key]:
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"target value for {key} is invalid")
        if patch.get("originalPresent") is True:
            index = patch.get("originalLineIndex")
            if not isinstance(index, int) or index < 0 or index >= len(lines):
                fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"original line index for {key} is invalid")
            expected_eol = line_ending_from_name(patch.get("originalLineEnding"))
            if lines[index] != f"{key}={patch.get('originalValue')}{expected_eol}":
                fail("ACTIVATION_PRE_BYTES_MISMATCH", f"signed original line for {key} does not match current env")
            lines[index] = f"{key}={TARGET[key]}{expected_eol}"
    missing = [key for key in TARGET_ORDER if patch_by_key[key].get("originalPresent") is False]
    append_eol = line_ending_from_name(rollback.get("appendLineEnding"))
    if append_eol not in ("\n", "\r\n"):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "append line ending must be LF or CRLF")
    if missing and lines and split_line(lines[-1])[1] == "":
        lines[-1] += append_eol
    for key in missing:
        patch = patch_by_key[key]
        index = patch.get("targetAppendedLineIndex")
        if not isinstance(index, int) or index != len(lines):
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"target append index for {key} is invalid")
        lines.append(f"{key}={TARGET[key]}{append_eol}")
    target = "".join(lines).encode("utf-8")
    if sha256_bytes(target) != record["targetEnvFingerprint"]:
        fail("ACTIVATION_TARGET_RECONSTRUCTION_MISMATCH", "reconstructed target does not match signed target fingerprint")
    return target


def reconstruct_rollback(raw: bytes, record: dict[str, Any]) -> bytes:
    if sha256_bytes(raw) != record["targetEnvFingerprint"]:
        fail("ACTIVATION_TARGET_FINGERPRINT_MISMATCH", "rollback requires exact signed target bytes")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("ACTIVATION_ENV_ENCODING_INVALID: env must be UTF-8") from exc
    lines = text.splitlines(keepends=True)
    rollback = record["rollbackDescriptor"]
    patches = rollback.get("patches")
    if not isinstance(patches, list) or len(patches) != len(TARGET_ORDER):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patches are invalid")
    for patch in reversed(patches):
        if not isinstance(patch, dict) or patch.get("key") not in TARGET:
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patch is invalid")
        key = patch["key"]
        if patch.get("originalPresent") is False:
            index = patch.get("targetAppendedLineIndex")
            if not isinstance(index, int) or index < 0 or index >= len(lines):
                fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"target append index for {key} is invalid")
            body, _ = split_line(lines[index])
            if body != f"{key}={TARGET[key]}":
                fail("ACTIVATION_TARGET_BYTES_MISMATCH", f"target line for {key} does not match signed target")
            del lines[index]
        else:
            index = patch.get("originalLineIndex")
            if not isinstance(index, int) or index < 0 or index >= len(lines):
                fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"original line index for {key} is invalid")
            body, _ = split_line(lines[index])
            if body != f"{key}={TARGET[key]}":
                fail("ACTIVATION_TARGET_BYTES_MISMATCH", f"target line for {key} does not match signed target")
            original_eol = line_ending_from_name(patch.get("originalLineEnding"))
            lines[index] = f"{key}={patch.get('originalValue')}{original_eol}"
    if lines and rollback.get("originalHadTrailingLineEnding") is False:
        body, _ = split_line(lines[-1])
        lines[-1] = body
    restored = "".join(lines).encode("utf-8")
    if sha256_bytes(restored) != record["currentEnvFingerprint"]:
        fail("ACTIVATION_ROLLBACK_RECONSTRUCTION_MISMATCH", "reconstructed rollback does not match signed pre-state fingerprint")
    return restored


def atomic_replace_env(path: Path, expected_before: str, target: bytes, expected_after: str) -> None:
    current, info = read_env(path)
    if sha256_bytes(current) != expected_before:
        fail("ACTIVATION_ATOMIC_PRECONDITION_CHANGED", "env fingerprint changed before atomic replacement")
    mode = stat.S_IMODE(info.st_mode)
    if os.geteuid() != 0 and info.st_uid != os.geteuid():
        fail("ACTIVATION_ENV_OWNER_UNSAFE", "executor cannot preserve env ownership")
    parent = path.parent
    if parent.is_symlink() or not parent.is_dir():
        fail("ACTIVATION_ENV_PARENT_UNSAFE", "env parent must be a regular non-symlink directory")
    temp = parent / f".{path.name}.activation-{os.getpid()}-{os.urandom(6).hex()}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(target)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, mode)
        if os.geteuid() == 0:
            os.chown(temp, info.st_uid, info.st_gid)
        current_again, _ = read_env(path)
        if sha256_bytes(current_again) != expected_before:
            fail("ACTIVATION_ATOMIC_PRECONDITION_CHANGED", "env fingerprint changed during atomic replacement")
        os.replace(temp, path)
        dir_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        temp.unlink(missing_ok=True)
    after, _ = read_env(path)
    if sha256_bytes(after) != expected_after:
        fail("ACTIVATION_ATOMIC_POSTCONDITION_FAILED", "atomic replacement did not produce expected fingerprint")


def receipt_payload(record: dict[str, Any]) -> bytes:
    return SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8")


def sign_receipt(record: dict[str, Any], key: bytes) -> str:
    return "hmac-sha256:" + hmac.new(key, receipt_payload(record), hashlib.sha256).hexdigest()


def receipt_path(context: dict[str, Any], phase: str) -> Path:
    return context["executionDir"] / PHASE_FILES[phase]


def expected_phase_state(phase: str, context: dict[str, Any]) -> tuple[str, bool, bool, bool]:
    record = context["record"]
    if phase == "MUTATION_STARTED":
        return record["currentEnvFingerprint"], False, False, False
    if phase == "COMPLETED":
        return record["targetEnvFingerprint"], True, True, True
    if phase == "ROLLBACK_STARTED":
        return record["targetEnvFingerprint"], True, False, False
    if phase == "ROLLED_BACK":
        return record["currentEnvFingerprint"], False, False, True
    fail("ACTIVATION_RECEIPT_PHASE_INVALID", "receipt phase is invalid")


def make_receipt(
    context: dict[str, Any],
    phase: str,
    previous_signature: str | None,
    attestation_fingerprint: str | None,
    validation_evidence_sha256: str | None,
) -> dict[str, Any]:
    expected_env, changed, executed, terminal = expected_phase_state(phase, context)
    if previous_signature is not None and not HMAC_SHA256.fullmatch(previous_signature):
        fail("ACTIVATION_RECEIPT_PREVIOUS_SIGNATURE_INVALID", "previous receipt signature is invalid")
    if attestation_fingerprint is not None and not SHA256.fullmatch(attestation_fingerprint):
        fail("ACTIVATION_RECEIPT_ATTESTATION_INVALID", "runtime attestation fingerprint is invalid")
    if validation_evidence_sha256 is not None and not SHA256.fullmatch(validation_evidence_sha256):
        fail("ACTIVATION_RECEIPT_VALIDATION_EVIDENCE_INVALID", "validation evidence fingerprint is invalid")
    record = {
        "receiptVersion": RECEIPT_VERSION,
        "phase": phase,
        "recordedAt": now_utc(),
        "activationId": context["activationId"],
        "planFingerprint": context["record"]["planFingerprint"],
        "executionId": context["executionId"],
        "executionFingerprint": context["executionFingerprint"],
        "pendingExecutionSignature": context["pendingSignature"],
        "pendingExecutionFileSha256": context["pendingFileSha256"],
        "previousReceiptSignature": previous_signature,
        "expectedEnvFingerprint": expected_env,
        "runtimeAttestationFingerprint": attestation_fingerprint,
        "validationEvidenceSha256": validation_evidence_sha256,
        "runtimeConfigurationChanged": changed,
        "activationExecuted": executed,
        "terminal": terminal,
    }
    if phase == "MUTATION_STARTED" and attestation_fingerprint is None:
        fail("ACTIVATION_RECEIPT_PRE_ATTESTATION_REQUIRED", "mutation start must bind verified DISABLED runtime attestation")
    if phase == "COMPLETED" and attestation_fingerprint is None:
        fail("ACTIVATION_RECEIPT_POST_ATTESTATION_REQUIRED", "completion must bind verified ENABLED runtime attestation")
    if phase == "ROLLBACK_STARTED" and validation_evidence_sha256 is None:
        fail("ACTIVATION_RECEIPT_ROLLBACK_EVIDENCE_REQUIRED", "rollback start must bind failed validation evidence")
    if phase == "ROLLED_BACK" and attestation_fingerprint is None:
        fail("ACTIVATION_RECEIPT_ROLLBACK_ATTESTATION_REQUIRED", "rolled-back receipt must bind verified DISABLED runtime attestation")
    return record


def verify_receipt(path: Path, context: dict[str, Any], phase: str, key: bytes, previous_signature: str | None) -> dict[str, Any] | None:
    if not path.exists():
        return None
    envelope = read_private_json(path, "ACTIVATION_RECEIPT")
    if envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("ACTIVATION_RECEIPT_INVALID", "receipt envelope is invalid")
    record = envelope["record"]
    signature = envelope.get("signature")
    if record.get("receiptVersion") != RECEIPT_VERSION or record.get("phase") != phase:
        fail("ACTIVATION_RECEIPT_INVALID", "receipt version or phase is invalid")
    for field, expected in (
        ("activationId", context["activationId"]),
        ("planFingerprint", context["record"]["planFingerprint"]),
        ("executionId", context["executionId"]),
        ("executionFingerprint", context["executionFingerprint"]),
        ("pendingExecutionSignature", context["pendingSignature"]),
        ("pendingExecutionFileSha256", context["pendingFileSha256"]),
        ("previousReceiptSignature", previous_signature),
    ):
        if record.get(field) != expected:
            fail("ACTIVATION_RECEIPT_BINDING_MISMATCH", f"receipt field {field} does not match activation evidence")
    expected_env, changed, executed, terminal = expected_phase_state(phase, context)
    if record.get("expectedEnvFingerprint") != expected_env or record.get("runtimeConfigurationChanged") is not changed or record.get("activationExecuted") is not executed or record.get("terminal") is not terminal:
        fail("ACTIVATION_RECEIPT_STATE_INVALID", "receipt state flags do not match phase")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_RECEIPT_SIGNATURE_INVALID", "receipt signature is invalid")
    expected_signature = sign_receipt(record, key)
    if not hmac.compare_digest(signature, expected_signature):
        fail("ACTIVATION_RECEIPT_SIGNATURE_MISMATCH", "receipt HMAC does not match")
    return envelope


def persist_receipt(path: Path, record: dict[str, Any], key: bytes) -> dict[str, Any]:
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_receipt(record, key)}
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fail("ACTIVATION_RECEIPT_CONFLICT", f"receipt already exists unexpectedly: {path.name}")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(path, 0o600)
        dir_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return envelope


def load_receipts(context: dict[str, Any], key: bytes) -> dict[str, dict[str, Any] | None]:
    started = verify_receipt(receipt_path(context, "MUTATION_STARTED"), context, "MUTATION_STARTED", key, None)
    if started is None:
        for phase in ("COMPLETED", "ROLLBACK_STARTED", "ROLLED_BACK"):
            if receipt_path(context, phase).exists():
                fail("ACTIVATION_RECEIPT_CHAIN_INVALID", "terminal/rollback receipt exists without mutation-start receipt")
        return {"started": None, "completed": None, "rollbackStarted": None, "rolledBack": None}
    start_sig = started["signature"]
    completed = verify_receipt(receipt_path(context, "COMPLETED"), context, "COMPLETED", key, start_sig)
    rollback_started = verify_receipt(receipt_path(context, "ROLLBACK_STARTED"), context, "ROLLBACK_STARTED", key, start_sig)
    if completed is not None and rollback_started is not None:
        fail("ACTIVATION_RECEIPT_CHAIN_INVALID", "activation cannot be both completed and rolling back")
    rolled_back = None
    if rollback_started is not None:
        rolled_back = verify_receipt(receipt_path(context, "ROLLED_BACK"), context, "ROLLED_BACK", key, rollback_started["signature"])
    elif receipt_path(context, "ROLLED_BACK").exists():
        fail("ACTIVATION_RECEIPT_CHAIN_INVALID", "rolled-back receipt lacks rollback-start receipt")
    return {"started": started, "completed": completed, "rollbackStarted": rollback_started, "rolledBack": rolled_back}


def ensure_receipt(
    context: dict[str, Any],
    key: bytes,
    phase: str,
    previous_signature: str | None,
    attestation_fingerprint: str | None = None,
    validation_evidence_sha256: str | None = None,
) -> dict[str, Any]:
    existing = verify_receipt(receipt_path(context, phase), context, phase, key, previous_signature)
    if existing is not None:
        return existing
    record = make_receipt(context, phase, previous_signature, attestation_fingerprint, validation_evidence_sha256)
    return persist_receipt(receipt_path(context, phase), record, key)


def result(status: str, context: dict[str, Any], **extra: Any) -> dict[str, Any]:
    raw, _ = read_env(Path(context["record"]["envFilePath"]))
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_EXECUTOR",
        "status": status,
        "activationId": context["activationId"],
        "executionId": context["executionId"],
        "planFingerprint": context["record"]["planFingerprint"],
        "actualEnvFingerprint": sha256_bytes(raw),
        "targetEnvFingerprint": context["record"]["targetEnvFingerprint"],
        "currentEnvFingerprint": context["record"]["currentEnvFingerprint"],
        **extra,
    }


def execute(args: argparse.Namespace) -> dict[str, Any]:
    context = load_context(args)
    key = read_key(args.key_file)
    receipts = load_receipts(context, key)
    record = context["record"]
    env_path = args.env_file

    if receipts["completed"] is not None:
        raw, _ = read_env(env_path)
        if sha256_bytes(raw) != record["targetEnvFingerprint"]:
            fail("ACTIVATION_COMPLETED_ENV_MISMATCH", "completed receipt conflicts with current env fingerprint")
        return result("COMPLETED", context, runtimeConfigurationChanged=True, activationExecuted=True, envMutationPerformed=False, rollbackPerformed=False)

    if receipts["rolledBack"] is not None:
        raw, _ = read_env(env_path)
        if sha256_bytes(raw) != record["currentEnvFingerprint"]:
            fail("ACTIVATION_ROLLED_BACK_ENV_MISMATCH", "rolled-back receipt conflicts with current env fingerprint")
        return result("ROLLED_BACK", context, runtimeConfigurationChanged=False, activationExecuted=False, envMutationPerformed=False, rollbackPerformed=False)

    if receipts["rollbackStarted"] is not None:
        raw, _ = read_env(env_path)
        current_fp = sha256_bytes(raw)
        rollback_performed = False
        if current_fp == record["targetEnvFingerprint"]:
            restored = reconstruct_rollback(raw, record)
            atomic_replace_env(env_path, record["targetEnvFingerprint"], restored, record["currentEnvFingerprint"])
            rollback_performed = True
        elif current_fp != record["currentEnvFingerprint"]:
            fail("ACTIVATION_ROLLBACK_ENV_DRIFT", "rollback recovery found env bytes outside signed pre/target states")
        ok, attestation, _ = runtime_attestation(args, "DISABLED")
        if not ok:
            fail("ACTIVATION_ROLLBACK_RUNTIME_NOT_READY", f"rolled-back env failed runtime validation: {attestation.get('blocker')}")
        rolled_back = ensure_receipt(
            context,
            key,
            "ROLLED_BACK",
            receipts["rollbackStarted"]["signature"],
            attestation_fingerprint=attestation.get("attestationFingerprint"),
        )
        return result("ROLLED_BACK", context, runtimeConfigurationChanged=False, activationExecuted=False, envMutationPerformed=False, rollbackPerformed=rollback_performed, terminalReceiptSignature=rolled_back["signature"])

    assessment = execution_assessment(args)
    if receipts["started"] is None:
        if assessment.get("status") != "READY_TO_APPLY":
            fail("ACTIVATION_TARGET_WITHOUT_MUTATION_START", "target state cannot be adopted without mutation-start receipt")
        pre_ok, pre_attestation, _ = runtime_attestation(args, "DISABLED")
        if not pre_ok:
            fail("ACTIVATION_PRE_RUNTIME_NOT_READY", f"pre-activation runtime validation failed: {pre_attestation.get('blocker')}")
        started = ensure_receipt(
            context,
            key,
            "MUTATION_STARTED",
            None,
            attestation_fingerprint=pre_attestation.get("attestationFingerprint"),
        )
        receipts["started"] = started
    start_signature = receipts["started"]["signature"]

    assessment = execution_assessment(args)
    env_mutation_performed = False
    if assessment.get("status") == "READY_TO_APPLY":
        raw, _ = read_env(env_path)
        target = reconstruct_target(raw, record)
        atomic_replace_env(env_path, record["currentEnvFingerprint"], target, record["targetEnvFingerprint"])
        env_mutation_performed = True
    elif assessment.get("status") != "READY_TO_VALIDATE":
        fail("ACTIVATION_EXECUTION_NOT_ACTIONABLE", f"unexpected PENDING assessment status: {assessment.get('status')}")

    enabled_ok, enabled_attestation, enabled_evidence_sha = runtime_attestation(args, "ENABLED")
    if enabled_ok:
        completed = ensure_receipt(
            context,
            key,
            "COMPLETED",
            start_signature,
            attestation_fingerprint=enabled_attestation.get("attestationFingerprint"),
        )
        return result("COMPLETED", context, runtimeConfigurationChanged=True, activationExecuted=True, envMutationPerformed=env_mutation_performed, rollbackPerformed=False, terminalReceiptSignature=completed["signature"])

    rollback_started = ensure_receipt(
        context,
        key,
        "ROLLBACK_STARTED",
        start_signature,
        validation_evidence_sha256=enabled_evidence_sha,
    )
    raw, _ = read_env(env_path)
    restored = reconstruct_rollback(raw, record)
    atomic_replace_env(env_path, record["targetEnvFingerprint"], restored, record["currentEnvFingerprint"])
    disabled_ok, disabled_attestation, _ = runtime_attestation(args, "DISABLED")
    if not disabled_ok:
        fail("ACTIVATION_ROLLBACK_RUNTIME_NOT_READY", f"automatic rollback restored bytes but runtime validation failed: {disabled_attestation.get('blocker')}")
    rolled_back = ensure_receipt(
        context,
        key,
        "ROLLED_BACK",
        rollback_started["signature"],
        attestation_fingerprint=disabled_attestation.get("attestationFingerprint"),
    )
    return result("ROLLED_BACK", context, runtimeConfigurationChanged=False, activationExecuted=False, envMutationPerformed=env_mutation_performed, rollbackPerformed=True, validationFailure=enabled_attestation.get("blocker"), terminalReceiptSignature=rolled_back["signature"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execution-checker", required=True, type=Path)
    parser.add_argument("--plan-checker", required=True, type=Path)
    parser.add_argument("--runtime-checker", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--pending-execution", required=True, type=Path)
    args = parser.parse_args()
    try:
        output = execute(args)
        print(json.dumps(output, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_EXECUTOR",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "runtimeConfigurationChanged": None,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
