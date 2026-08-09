#!/usr/bin/env python3
"""Atomically apply or roll back the five backup-privacy .env mutations authorized by plan v2."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

ROLLBACK_INTENT_VERSION = 1
ROLLBACK_FILE = "activation-env-rollback-pending.json"
ROLLBACK_SIGNING_DOMAIN = b"masters:backup-privacy-activation-env-rollback:v1\n"
ROLLBACK_STRATEGY = "REVERSE_ONLY_BOUND_BACKUP_PRIVACY_LINES_V1"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
EXECUTION_ID = re.compile(r"^execution-[0-9a-f]{32}$")
TARGET_ORDER = (
    "PRIVACY_BACKUP_STATE",
    "PRIVACY_BACKUP_POLICY_VERSION",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION",
)
ROLLBACK_REASONS = {
    "POST_WRITE_RUNTIME_ATTESTATION_FAILED",
    "RUNTIME_RESTART_FAILED",
    "OPERATOR_ABORT_BEFORE_RUNTIME_ACTIVATION",
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_ENV_KEY_UNSAFE", "key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ACTIVATION_ENV_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("ACTIVATION_ENV_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def read_env(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ENV_FILE_UNSAFE", "env file must be an absolute regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o022:
        fail("ENV_FILE_PERMISSIONS_UNSAFE", "env file must not be group/world writable")
    return path.read_bytes()


def load_plan(path: Path, env_path: Path) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_PLAN_FILE_UNSAFE", "plan must be an absolute regular non-symlink file")
    envelope = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1:
        fail("ACTIVATION_PLAN_INVALID", "plan envelope is invalid")
    record = envelope.get("record")
    signature = envelope.get("signature")
    if not isinstance(record, dict) or record.get("activationPlanVersion") != 2:
        fail("ACTIVATION_PLAN_INVALID", "reversible activation plan v2 is required")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_PLAN_SIGNATURE_INVALID", "plan signature is invalid")
    activation_id = record.get("activationId")
    if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
        fail("ACTIVATION_ID_INVALID", "activation ID is invalid")
    if record.get("envFilePath") != str(env_path):
        fail("ACTIVATION_ENV_PATH_MISMATCH", "env path does not match signed plan")
    for field in ("currentEnvFingerprint", "targetEnvFingerprint", "planFingerprint"):
        value = record.get(field)
        if not isinstance(value, str) or not SHA256.fullmatch(value):
            fail("ACTIVATION_PLAN_FINGERPRINT_INVALID", f"{field} is invalid")
    rollback = record.get("rollbackDescriptor")
    if not isinstance(rollback, dict) or rollback.get("strategy") != ROLLBACK_STRATEGY:
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "plan rollback descriptor is invalid")
    if not isinstance(rollback.get("patches"), list) or len(rollback["patches"]) != len(TARGET_ORDER):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "plan must bind exactly five rollback patches")
    if [item.get("key") for item in rollback["patches"] if isinstance(item, dict)] != list(TARGET_ORDER):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patch order is invalid")
    for flag in (
        "atomicReplaceRequired",
        "postWriteRuntimeAttestationRequired",
        "rollbackOnValidationFailureRequired",
        "exactRollbackReconstructionRequired",
        "nonTargetEnvBytesMustRemainUnchanged",
    ):
        if record.get(flag) is not True:
            fail("ACTIVATION_PLAN_POLICY_INVALID", f"{flag} must be true")
    return envelope


def run_execution_check(
    checker: Path,
    plan_checker: Path,
    plan: Path,
    key_file: Path,
    env_file: Path,
    execution: Path,
) -> dict[str, Any]:
    for path, label in ((checker, "execution checker"), (plan_checker, "plan checker")):
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            fail("ACTIVATION_ENV_CHECKER_UNSAFE", f"{label} must be an absolute regular non-symlink file")
    proc = subprocess.run(
        [
            sys.executable,
            str(checker),
            "check",
            "--plan-checker",
            str(plan_checker),
            "--plan",
            str(plan),
            "--key-file",
            str(key_file),
            "--env-file",
            str(env_file),
            "--execution",
            str(execution),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_EXECUTION_CHECK_OUTPUT_INVALID: execution checker did not return JSON") from exc
    if proc.returncode != 0 or result.get("status") == "BLOCKED":
        fail("ACTIVATION_EXECUTION_NOT_VERIFIED", f"execution evidence check failed: {result.get('blocker')}")
    if result.get("activationExecuted") is not False:
        fail("ACTIVATION_EXECUTION_ALREADY_TERMINAL", "env executor requires non-terminal execution evidence")
    return result


def load_planner(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_PLANNER_UNSAFE", "planner must be an absolute regular non-symlink file")
    spec = importlib.util.spec_from_file_location("backup_privacy_activation_planner_v2", path)
    if spec is None or spec.loader is None:
        fail("ACTIVATION_PLANNER_IMPORT_FAILED", "planner could not be imported")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "build_reversible_target_env", None)):
        fail("ACTIVATION_PLANNER_INVALID", "planner lacks reversible target builder")
    return module


def build_target(raw: bytes, record: dict[str, Any], planner: Any) -> bytes:
    target_raw, _, rollback = planner.build_reversible_target_env(raw)
    if sha256_bytes(raw) != record["currentEnvFingerprint"]:
        fail("ACTIVATION_PRE_FINGERPRINT_MISMATCH", "current env bytes no longer match signed pre-state")
    if sha256_bytes(target_raw) != record["targetEnvFingerprint"]:
        fail("ACTIVATION_TARGET_FINGERPRINT_MISMATCH", "reconstructed target bytes do not match signed target")
    if canonical_json(rollback) != canonical_json(record["rollbackDescriptor"]):
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_MISMATCH", "recomputed rollback descriptor does not match signed plan")
    if getattr(planner, "TARGET", None) != record.get("activationTarget"):
        fail("ACTIVATION_TARGET_POLICY_MISMATCH", "planner target does not match signed activation target")
    return target_raw


def split_line(line: str) -> tuple[str, str]:
    if line.endswith("\r\n"):
        return line[:-2], "\r\n"
    if line.endswith("\n"):
        return line[:-1], "\n"
    if line.endswith("\r"):
        fail("ENV_LINE_ENDING_UNSUPPORTED", "CR-only line endings are not supported")
    return line, ""


def eol_from_descriptor(value: Any) -> str:
    if value == "CRLF":
        return "\r\n"
    if value == "LF":
        return "\n"
    if value == "NONE":
        return ""
    fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback line ending is invalid")


def reconstruct_original(target_raw: bytes, record: dict[str, Any]) -> bytes:
    if sha256_bytes(target_raw) != record["targetEnvFingerprint"]:
        fail("ACTIVATION_TARGET_FINGERPRINT_MISMATCH", "rollback requires exact signed target bytes")
    try:
        text = target_raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("ENV_FILE_ENCODING_INVALID: env file must be UTF-8") from exc
    lines = text.splitlines(keepends=True)
    rollback = record["rollbackDescriptor"]
    patches = rollback["patches"]
    appended: list[int] = []
    for patch in patches:
        if not isinstance(patch, dict) or patch.get("key") not in TARGET_ORDER:
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "rollback patch is invalid")
        key = patch["key"]
        target_value = patch.get("targetValue")
        if not isinstance(target_value, str):
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"target value for {key} is invalid")
        if patch.get("originalPresent") is True:
            index = patch.get("originalLineIndex")
            original_value = patch.get("originalValue")
            if not isinstance(index, int) or index < 0 or index >= len(lines) or not isinstance(original_value, str):
                fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"original binding for {key} is invalid")
            body, eol = split_line(lines[index])
            expected_eol = eol_from_descriptor(patch.get("originalLineEnding"))
            if body != f"{key}={target_value}" or eol != expected_eol:
                fail("ACTIVATION_ROLLBACK_TARGET_MISMATCH", f"target line for {key} does not match signed descriptor")
            lines[index] = f"{key}={original_value}{expected_eol}"
        elif patch.get("originalPresent") is False:
            index = patch.get("targetAppendedLineIndex")
            if not isinstance(index, int) or index < 0 or index >= len(lines):
                fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"appended binding for {key} is invalid")
            body, eol = split_line(lines[index])
            append_eol = eol_from_descriptor(rollback.get("appendLineEnding"))
            if body != f"{key}={target_value}" or eol != append_eol:
                fail("ACTIVATION_ROLLBACK_TARGET_MISMATCH", f"appended target line for {key} does not match signed descriptor")
            appended.append(index)
        else:
            fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", f"originalPresent for {key} is invalid")

    for index in sorted(appended, reverse=True):
        lines.pop(index)

    if rollback.get("originalHadTrailingLineEnding") is False and lines:
        body, eol = split_line(lines[-1])
        append_eol = eol_from_descriptor(rollback.get("appendLineEnding"))
        if eol == append_eol:
            lines[-1] = body
        elif eol:
            fail("ACTIVATION_ROLLBACK_TARGET_MISMATCH", "final line ending does not match signed rollback descriptor")
    elif rollback.get("originalHadTrailingLineEnding") is not True:
        fail("ACTIVATION_ROLLBACK_DESCRIPTOR_INVALID", "original trailing-line-ending flag is invalid")

    original = "".join(lines).encode("utf-8")
    if sha256_bytes(original) != record["currentEnvFingerprint"]:
        fail("ACTIVATION_ROLLBACK_RECONSTRUCTION_MISMATCH", "reconstructed bytes do not match signed pre-state")
    return original


def preserve_temp_metadata(fd: int, source_stat: os.stat_result) -> None:
    mode = stat.S_IMODE(source_stat.st_mode)
    os.fchmod(fd, mode)
    euid = os.geteuid()
    if euid == 0:
        os.fchown(fd, source_stat.st_uid, source_stat.st_gid)
    elif source_stat.st_uid != euid:
        fail("ENV_FILE_OWNERSHIP_UNSAFE", "non-root executor may only replace an env file it owns")
    elif source_stat.st_gid != os.getegid():
        if source_stat.st_gid not in os.getgroups():
            fail("ENV_FILE_GROUP_UNPRESERVABLE", "executor cannot preserve env file group")
        os.fchown(fd, -1, source_stat.st_gid)


def atomic_replace(env_file: Path, expected_before: str, replacement: bytes, expected_after: str) -> None:
    current = read_env(env_file)
    if sha256_bytes(current) != expected_before:
        fail("ENV_FINGERPRINT_CHANGED_BEFORE_REPLACE", "env bytes changed before atomic replace")
    source_stat = env_file.stat()
    temp = env_file.parent / f".{env_file.name}.backup-privacy.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temp, flags, stat.S_IMODE(source_stat.st_mode))
    try:
        preserve_temp_metadata(fd, source_stat)
        with os.fdopen(fd, "wb", closefd=True) as handle:
            handle.write(replacement)
            handle.flush()
            os.fsync(handle.fileno())
        fd = -1
        if sha256_bytes(read_env(env_file)) != expected_before:
            fail("ENV_FINGERPRINT_CHANGED_BEFORE_REPLACE", "env bytes changed during replace preparation")
        os.replace(temp, env_file)
        directory_fd = os.open(env_file.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        if env_file.is_symlink() or not env_file.is_file():
            fail("ENV_FILE_UNSAFE_AFTER_REPLACE", "env file became unsafe after replace")
        final_stat = env_file.stat()
        if stat.S_IMODE(final_stat.st_mode) != stat.S_IMODE(source_stat.st_mode):
            fail("ENV_FILE_MODE_CHANGED", "env file mode changed during replace")
        if final_stat.st_uid != source_stat.st_uid or final_stat.st_gid != source_stat.st_gid:
            fail("ENV_FILE_OWNERSHIP_CHANGED", "env file ownership changed during replace")
        if sha256_bytes(env_file.read_bytes()) != expected_after:
            fail("ENV_POST_REPLACE_FINGERPRINT_MISMATCH", "env bytes do not match expected post-state")
    finally:
        if fd >= 0:
            os.close(fd)
        temp.unlink(missing_ok=True)


def rollback_record(
    plan_envelope: dict[str, Any],
    execution: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    record = plan_envelope["record"]
    result: dict[str, Any] = {
        "rollbackIntentVersion": ROLLBACK_INTENT_VERSION,
        "phase": "PENDING",
        "activationId": record["activationId"],
        "executionId": execution.get("executionId"),
        "executionFingerprint": execution.get("executionFingerprint"),
        "planFingerprint": record["planFingerprint"],
        "planSignature": plan_envelope["signature"],
        "envFilePath": record["envFilePath"],
        "targetEnvFingerprint": record["targetEnvFingerprint"],
        "rollbackEnvFingerprint": record["currentEnvFingerprint"],
        "rollbackStrategy": ROLLBACK_STRATEGY,
        "reasonCode": reason,
        "rollbackMutationStarted": False,
        "runtimeConfigurationChanged": True,
        "activationExecuted": False,
    }
    if not isinstance(result["executionId"], str) or not EXECUTION_ID.fullmatch(result["executionId"]):
        fail("ACTIVATION_EXECUTION_ID_INVALID", "execution ID is invalid")
    if not isinstance(result["executionFingerprint"], str) or not SHA256.fullmatch(result["executionFingerprint"]):
        fail("ACTIVATION_EXECUTION_FINGERPRINT_INVALID", "execution fingerprint is invalid")
    result["rollbackIntentFingerprint"] = "sha256:" + hashlib.sha256(canonical_json(result).encode()).hexdigest()
    return result


def sign_rollback(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, ROLLBACK_SIGNING_DOMAIN + canonical_json(payload).encode(), hashlib.sha256).hexdigest()


def rollback_path(execution_path: Path, activation_id: str) -> Path:
    if not execution_path.is_absolute() or execution_path.name != "activation-execution-pending.json":
        fail("ACTIVATION_EXECUTION_PATH_INVALID", "execution path is invalid")
    if execution_path.parent.name != activation_id:
        fail("ACTIVATION_EXECUTION_PATH_BINDING_MISMATCH", "execution path does not match activation ID")
    parent = execution_path.parent
    if parent.is_symlink() or not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) & 0o077:
        fail("ACTIVATION_EXECUTION_DIR_UNSAFE", "execution directory must be a private non-symlink directory")
    return parent / ROLLBACK_FILE


def validate_rollback_record(record: dict[str, Any], expected: dict[str, Any]) -> None:
    if record.get("rollbackIntentVersion") != 1 or record.get("phase") != "PENDING":
        fail("ACTIVATION_ROLLBACK_INTENT_INVALID", "rollback intent version or phase is invalid")
    for field in (
        "activationId",
        "executionId",
        "executionFingerprint",
        "planFingerprint",
        "planSignature",
        "envFilePath",
        "targetEnvFingerprint",
        "rollbackEnvFingerprint",
        "rollbackStrategy",
    ):
        if record.get(field) != expected.get(field):
            fail("ACTIVATION_ROLLBACK_INTENT_BINDING_MISMATCH", f"rollback intent does not match {field}")
    if record.get("reasonCode") not in ROLLBACK_REASONS:
        fail("ACTIVATION_ROLLBACK_REASON_INVALID", "rollback reason code is invalid")
    if record.get("rollbackMutationStarted") is not False or record.get("runtimeConfigurationChanged") is not True or record.get("activationExecuted") is not False:
        fail("ACTIVATION_ROLLBACK_INTENT_BOUNDARY_INVALID", "rollback intent must precede rollback mutation")
    fingerprint = record.get("rollbackIntentFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("ACTIVATION_ROLLBACK_INTENT_FINGERPRINT_INVALID", "rollback intent fingerprint is invalid")
    body = dict(record)
    body.pop("rollbackIntentFingerprint")
    expected_fp = "sha256:" + hashlib.sha256(canonical_json(body).encode()).hexdigest()
    if not hmac.compare_digest(fingerprint, expected_fp):
        fail("ACTIVATION_ROLLBACK_INTENT_FINGERPRINT_MISMATCH", "rollback intent fingerprint does not match record")


def read_rollback(path: Path, key: bytes, expected: dict[str, Any]) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("ACTIVATION_ROLLBACK_INTENT_UNSAFE", "rollback intent must be a private regular non-symlink file")
    envelope = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("ACTIVATION_ROLLBACK_INTENT_INVALID", "rollback intent envelope is invalid")
    validate_rollback_record(envelope["record"], expected)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_ROLLBACK_INTENT_SIGNATURE_INVALID", "rollback intent signature is invalid")
    expected_sig = sign_rollback(envelope["record"], key)
    if not hmac.compare_digest(signature, expected_sig):
        fail("ACTIVATION_ROLLBACK_INTENT_SIGNATURE_MISMATCH", "rollback intent HMAC does not match record")
    return envelope


def persist_rollback(path: Path, envelope: dict[str, Any]) -> bool:
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        fail("ACTIVATION_ROLLBACK_INTENT_CONFLICT", "rollback intent already exists")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        fd = -1
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return True
    finally:
        if fd >= 0:
            os.close(fd)


def expected_rollback_binding(plan_envelope: dict[str, Any], execution: dict[str, Any]) -> dict[str, Any]:
    record = plan_envelope["record"]
    return {
        "activationId": record["activationId"],
        "executionId": execution.get("executionId"),
        "executionFingerprint": execution.get("executionFingerprint"),
        "planFingerprint": record["planFingerprint"],
        "planSignature": plan_envelope["signature"],
        "envFilePath": record["envFilePath"],
        "targetEnvFingerprint": record["targetEnvFingerprint"],
        "rollbackEnvFingerprint": record["currentEnvFingerprint"],
        "rollbackStrategy": ROLLBACK_STRATEGY,
    }


def base_context(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], bytes, Path]:
    plan = load_plan(args.plan, args.env_file)
    execution = run_execution_check(
        args.execution_checker,
        args.plan_checker,
        args.plan,
        args.key_file,
        args.env_file,
        args.execution,
    )
    if execution.get("activationId") != plan["record"]["activationId"] or execution.get("planFingerprint") != plan["record"]["planFingerprint"]:
        fail("ACTIVATION_EXECUTION_BINDING_MISMATCH", "execution evidence does not match signed plan")
    key = read_key(args.key_file)
    rb_path = rollback_path(args.execution, plan["record"]["activationId"])
    return plan, execution, key, rb_path


def apply_target(args: argparse.Namespace) -> dict[str, Any]:
    plan, execution, key, rb_path = base_context(args)
    if rb_path.exists():
        read_rollback(rb_path, key, expected_rollback_binding(plan, execution))
        fail("ACTIVATION_ROLLBACK_ALREADY_AUTHORIZED", "target cannot be applied after rollback intent exists")
    status = execution.get("status")
    record = plan["record"]
    if status == "READY_TO_VALIDATE":
        if sha256_bytes(read_env(args.env_file)) != record["targetEnvFingerprint"]:
            fail("ACTIVATION_TARGET_FINGERPRINT_MISMATCH", "target recovery state is inconsistent")
        return {
            "mode": "BACKUP_PRIVACY_ACTIVATION_ENV_EXECUTOR",
            "status": "TARGET_ALREADY_APPLIED",
            "activationId": record["activationId"],
            "envMutationApplied": False,
            "postWriteValidationRequired": True,
            "runtimeConfigurationChanged": True,
            "activationExecuted": False,
        }
    if status != "READY_TO_APPLY" or execution.get("activationMutationAllowed") is not True:
        fail("ACTIVATION_TARGET_NOT_AUTHORIZED", f"target apply is not allowed from execution state {status}")
    raw = read_env(args.env_file)
    planner = load_planner(args.planner)
    target = build_target(raw, record, planner)
    atomic_replace(args.env_file, record["currentEnvFingerprint"], target, record["targetEnvFingerprint"])
    post = run_execution_check(args.execution_checker, args.plan_checker, args.plan, args.key_file, args.env_file, args.execution)
    if post.get("status") != "READY_TO_VALIDATE":
        fail("ACTIVATION_TARGET_POSTCHECK_FAILED", "execution evidence did not enter READY_TO_VALIDATE after target replace")
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_ENV_EXECUTOR",
        "status": "TARGET_APPLIED",
        "activationId": record["activationId"],
        "envMutationApplied": True,
        "postWriteValidationRequired": True,
        "runtimeConfigurationChanged": True,
        "activationExecuted": False,
    }


def prepare_rollback(args: argparse.Namespace) -> dict[str, Any]:
    if args.reason_code not in ROLLBACK_REASONS:
        fail("ACTIVATION_ROLLBACK_REASON_INVALID", "unsupported rollback reason code")
    plan, execution, key, rb_path = base_context(args)
    binding = expected_rollback_binding(plan, execution)
    if rb_path.exists():
        existing = read_rollback(rb_path, key, binding)
        if existing["record"]["reasonCode"] != args.reason_code:
            fail("ACTIVATION_ROLLBACK_INTENT_CONFLICT", "existing rollback reason differs")
        return {
            "mode": "BACKUP_PRIVACY_ACTIVATION_ENV_ROLLBACK_INTENT",
            "status": "ROLLBACK_INTENT_REUSED",
            "activationId": plan["record"]["activationId"],
            "rollbackIntentPath": str(rb_path),
            "rollbackMutationAllowed": execution.get("status") == "READY_TO_VALIDATE",
            "rollbackValidationRequired": execution.get("status") == "READY_TO_APPLY",
            "activationExecuted": False,
        }
    if execution.get("status") != "READY_TO_VALIDATE":
        fail("ACTIVATION_ROLLBACK_INTENT_NOT_ALLOWED", "new rollback intent requires exact target state")
    record = rollback_record(plan, execution, args.reason_code)
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_rollback(record, key)}
    persist_rollback(rb_path, envelope)
    read_rollback(rb_path, key, binding)
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_ENV_ROLLBACK_INTENT",
        "status": "ROLLBACK_INTENT_PENDING",
        "activationId": plan["record"]["activationId"],
        "rollbackIntentPath": str(rb_path),
        "rollbackMutationAllowed": True,
        "rollbackValidationRequired": False,
        "activationExecuted": False,
    }


def apply_rollback(args: argparse.Namespace) -> dict[str, Any]:
    plan, execution, key, rb_path = base_context(args)
    binding = expected_rollback_binding(plan, execution)
    if not rb_path.exists():
        fail("ACTIVATION_ROLLBACK_INTENT_MISSING", "signed rollback intent must exist before rollback mutation")
    read_rollback(rb_path, key, binding)
    record = plan["record"]
    status = execution.get("status")
    if status == "READY_TO_APPLY":
        if sha256_bytes(read_env(args.env_file)) != record["currentEnvFingerprint"]:
            fail("ACTIVATION_ROLLBACK_FINGERPRINT_MISMATCH", "rollback recovery state is inconsistent")
        return {
            "mode": "BACKUP_PRIVACY_ACTIVATION_ENV_EXECUTOR",
            "status": "ROLLBACK_ALREADY_APPLIED",
            "activationId": record["activationId"],
            "envMutationApplied": False,
            "rollbackValidationRequired": True,
            "runtimeConfigurationChanged": False,
            "activationExecuted": False,
        }
    if status != "READY_TO_VALIDATE":
        fail("ACTIVATION_ROLLBACK_NOT_AUTHORIZED", f"rollback is not allowed from execution state {status}")
    target = read_env(args.env_file)
    original = reconstruct_original(target, record)
    atomic_replace(args.env_file, record["targetEnvFingerprint"], original, record["currentEnvFingerprint"])
    post = run_execution_check(args.execution_checker, args.plan_checker, args.plan, args.key_file, args.env_file, args.execution)
    if post.get("status") != "READY_TO_APPLY":
        fail("ACTIVATION_ROLLBACK_POSTCHECK_FAILED", "execution evidence did not return to pre-state after rollback")
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_ENV_EXECUTOR",
        "status": "ROLLBACK_APPLIED",
        "activationId": record["activationId"],
        "envMutationApplied": True,
        "rollbackValidationRequired": True,
        "runtimeConfigurationChanged": False,
        "activationExecuted": False,
    }


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--planner", required=True, type=Path)
    parser.add_argument("--plan-checker", required=True, type=Path)
    parser.add_argument("--execution-checker", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--execution", required=True, type=Path)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    target = sub.add_parser("apply-target")
    add_common(target)
    prepare_rb = sub.add_parser("prepare-rollback")
    add_common(prepare_rb)
    prepare_rb.add_argument("--reason-code", required=True)
    rollback = sub.add_parser("apply-rollback")
    add_common(rollback)
    args = parser.parse_args()
    try:
        if args.command == "apply-target":
            result = apply_target(args)
        elif args.command == "prepare-rollback":
            result = prepare_rollback(args)
        else:
            result = apply_rollback(args)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        code = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_ENV_EXECUTOR",
            "status": "BLOCKED",
            "blocker": code,
            "envMutationApplied": False,
            "runtimeConfigurationChanged": False,
            "activationExecuted": False,
        }, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
