#!/usr/bin/env python3
"""Independently verify signed terminal backup-privacy activation completion evidence."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-activation-executor:v1\n"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
EXECUTION_ID = re.compile(r"^execution-[0-9a-f]{32}$")
COMPLETION_FILE = "activation-execution-completed.json"
ROLLBACK_FILES = (
    "activation-execution-rollback-started.json",
    "activation-execution-rollback-verified.json",
)


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_private(path: Path, code: str) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{code}_UNSAFE", "file must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must be private")
    return path.read_bytes()


def read_key(path: Path) -> bytes:
    raw = read_private(path, "ACTIVATION_COMPLETION_KEY")
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ACTIVATION_COMPLETION_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("ACTIVATION_COMPLETION_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def run_json(command: list[str]) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(command, check=False, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_COMPLETION_CHECK_OUTPUT_INVALID: dependency did not return JSON") from exc
    if not isinstance(result, dict):
        fail("ACTIVATION_COMPLETION_CHECK_OUTPUT_INVALID", "dependency output must be a JSON object")
    return proc.returncode, result


def verify_plan(checker: Path, plan: Path, key_file: Path) -> dict[str, Any]:
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("ACTIVATION_PLAN_CHECKER_UNSAFE", "plan checker is unsafe")
    code, result = run_json([sys.executable, str(checker), "--plan", str(plan), "--key-file", str(key_file)])
    if code != 0 or result.get("status") != "ACTIVATION_PLAN_VERIFIED" or result.get("activationPlanVersion") != 2:
        fail("ACTIVATION_PLAN_NOT_VERIFIED", f"plan verification failed: {result.get('blocker')}")
    return result


def verify_pending(checker: Path, plan_checker: Path, plan: Path, key_file: Path, env_file: Path, pending: Path) -> dict[str, Any]:
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("ACTIVATION_EXECUTION_CHECKER_UNSAFE", "execution evidence checker is unsafe")
    code, result = run_json([
        sys.executable, str(checker), "check",
        "--plan-checker", str(plan_checker), "--plan", str(plan),
        "--key-file", str(key_file), "--env-file", str(env_file),
        "--execution", str(pending),
    ])
    if code != 0 or result.get("status") != "READY_TO_VALIDATE":
        fail("ACTIVATION_EXECUTION_NOT_POST_WRITE", f"PENDING evidence does not bind current target state: {result.get('blocker')}")
    return result


def read_plan(path: Path, verified: dict[str, Any], env_file: Path) -> dict[str, Any]:
    raw = read_private(path, "ACTIVATION_PLAN")
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_PLAN_INVALID: plan is not JSON") from exc
    record = envelope.get("record") if isinstance(envelope, dict) else None
    if not isinstance(record, dict) or record.get("activationPlanVersion") != 2:
        fail("ACTIVATION_PLAN_INVALID", "plan record is invalid")
    activation_id = record.get("activationId")
    if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
        fail("ACTIVATION_ID_INVALID", "activation ID is invalid")
    if verified.get("activationId") != activation_id or verified.get("planFingerprint") != record.get("planFingerprint"):
        fail("ACTIVATION_PLAN_BINDING_MISMATCH", "verified plan output differs from plan record")
    if record.get("envFilePath") != str(env_file):
        fail("ACTIVATION_ENV_PATH_MISMATCH", "plan is not bound to requested env file")
    for field in ("currentEnvFingerprint", "targetEnvFingerprint", "planFingerprint"):
        if not isinstance(record.get(field), str) or not SHA256.fullmatch(record[field]):
            fail("ACTIVATION_PLAN_FINGERPRINT_INVALID", f"{field} is invalid")
    return record


def expected_signature(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def verify_completion(path: Path, key: bytes, plan: dict[str, Any], pending_result: dict[str, Any], pending: Path) -> dict[str, Any]:
    if path.name != COMPLETION_FILE or path.parent != pending.parent:
        fail("ACTIVATION_COMPLETION_PATH_INVALID", "completion must be canonical and colocated with PENDING evidence")
    raw = read_private(path, "ACTIVATION_COMPLETION")
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_COMPLETION_INVALID: completion is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1:
        fail("ACTIVATION_COMPLETION_INVALID", "completion envelope version is invalid")
    record = envelope.get("record")
    signature = envelope.get("signature")
    if not isinstance(record, dict) or record.get("activationExecutorVersion") != 1 or record.get("phase") != "COMPLETED":
        fail("ACTIVATION_COMPLETION_INVALID", "completion record is invalid")
    if record.get("activationId") != plan["activationId"] or path.parent.name != plan["activationId"]:
        fail("ACTIVATION_COMPLETION_BINDING_MISMATCH", "completion activation binding is invalid")
    execution_id = pending_result.get("executionId")
    if not isinstance(execution_id, str) or not EXECUTION_ID.fullmatch(execution_id) or record.get("executionId") != execution_id:
        fail("ACTIVATION_COMPLETION_EXECUTION_MISMATCH", "completion execution ID differs from PENDING assessment")
    for field in ("executionFingerprint", "planFingerprint"):
        if record.get(field) != pending_result.get(field):
            fail("ACTIVATION_COMPLETION_BINDING_MISMATCH", f"completion {field} differs from PENDING assessment")
    expected_pending_sha = sha256_bytes(read_private(pending, "ACTIVATION_EXECUTION"))
    expected = {
        "pendingEvidenceSha256": expected_pending_sha,
        "planFingerprint": plan["planFingerprint"],
        "envFilePath": plan["envFilePath"],
        "currentEnvFingerprint": plan["currentEnvFingerprint"],
        "targetEnvFingerprint": plan["targetEnvFingerprint"],
    }
    for field, value in expected.items():
        if record.get(field) != value:
            fail("ACTIVATION_COMPLETION_BINDING_MISMATCH", f"completion {field} mismatch")
    runtime_sha = record.get("runtimeAttestationSha256")
    if not isinstance(runtime_sha, str) or not SHA256.fullmatch(runtime_sha):
        fail("ACTIVATION_COMPLETION_RUNTIME_SHA_INVALID", "runtime attestation SHA-256 is invalid")
    if record.get("failureReasonCode") is not None or record.get("runtimeConfigurationChanged") is not True or record.get("activationExecuted") is not True or record.get("terminal") is not True:
        fail("ACTIVATION_COMPLETION_STATE_INVALID", "terminal completion flags are invalid")
    fingerprint = record.get("markerFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("ACTIVATION_COMPLETION_FINGERPRINT_INVALID", "marker fingerprint is invalid")
    body = dict(record)
    body.pop("markerFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode("utf-8"))):
        fail("ACTIVATION_COMPLETION_FINGERPRINT_MISMATCH", "marker fingerprint does not match record")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_COMPLETION_SIGNATURE_INVALID", "completion signature is invalid")
    if not hmac.compare_digest(signature, expected_signature(record, key)):
        fail("ACTIVATION_COMPLETION_SIGNATURE_MISMATCH", "completion HMAC does not match record")
    for rollback_name in ROLLBACK_FILES:
        if path.parent.joinpath(rollback_name).exists():
            fail("ACTIVATION_COMPLETION_STATE_CONFLICT", "completion cannot coexist with rollback evidence")
    return envelope


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan-checker", required=True, type=Path)
    parser.add_argument("--evidence-checker", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--completion", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        key = read_key(args.key_file)
        verified = verify_plan(args.plan_checker, args.plan, args.key_file)
        plan = read_plan(args.plan, verified, args.env_file)
        env_raw = read_private(args.env_file, "ENV_FILE")
        if sha256_bytes(env_raw) != plan["targetEnvFingerprint"]:
            fail("ACTIVATION_COMPLETION_ENV_DRIFT", "current env no longer matches signed target fingerprint")
        pending_result = verify_pending(args.evidence_checker, args.plan_checker, args.plan, args.key_file, args.env_file, args.pending)
        completion = verify_completion(args.completion, key, plan, pending_result, args.pending)
        record = completion["record"]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_COMPLETION_VERIFICATION",
            "status": "ACTIVATION_COMPLETION_VERIFIED",
            "activationId": record["activationId"],
            "executionId": record["executionId"],
            "planFingerprint": record["planFingerprint"],
            "completionFingerprint": record["markerFingerprint"],
            "completionFileSha256": sha256_bytes(read_private(args.completion, "ACTIVATION_COMPLETION")),
            "runtimeAttestationSha256": record["runtimeAttestationSha256"],
            "targetEnvFingerprint": record["targetEnvFingerprint"],
            "serviceCutoverPlanningAllowed": True,
            "serviceCutoverExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_COMPLETION_VERIFICATION",
            "status": "BLOCKED",
            "blocker": blocker,
            "serviceCutoverPlanningAllowed": False,
            "serviceCutoverExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
