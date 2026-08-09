#!/usr/bin/env python3
"""Verify nonterminal backup-privacy target-handoff evidence and current target config."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-activation-target-handoff:v1\n"
HANDOFF_FILE = "activation-target-handoff.json"


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def load_legacy(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("TARGET_HANDOFF_LEGACY_EXECUTOR_UNSAFE", "legacy executor must be an absolute regular file")
    spec = importlib.util.spec_from_file_location("backup_privacy_activation_executor_check", path)
    if spec is None or spec.loader is None:
        fail("TARGET_HANDOFF_LEGACY_EXECUTOR_INVALID", "could not load activation executor helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def checker_command(path: Path) -> list[str]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("TARGET_CONFIGURATION_CHECKER_UNSAFE", "target checker must be an absolute regular file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("TARGET_CONFIGURATION_CHECKER_PERMISSIONS_UNSAFE", "target checker must not be group/world writable")
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
    digest = sha256_bytes(proc.stdout)
    try:
        result = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("TARGET_CONFIGURATION_CHECK_OUTPUT_INVALID: checker did not return JSON") from exc
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


def expected_signature(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def validate_record(record: dict[str, Any], binding: dict[str, Any], checker: Path, checker_sha: str, legacy: Any) -> None:
    if record.get("targetHandoffVersion") != 1 or record.get("phase") != "TARGET_HANDOFF_READY":
        fail("TARGET_HANDOFF_INVALID", "handoff version/phase is invalid")
    recorded_at = record.get("recordedAt")
    if not isinstance(recorded_at, str):
        fail("TARGET_HANDOFF_TIMESTAMP_INVALID", "recordedAt is missing")
    legacy.validate_timestamp(recorded_at)
    for field, expected in binding.items():
        if record.get(field) != expected:
            fail("TARGET_HANDOFF_BINDING_MISMATCH", f"handoff field {field} differs from execution binding")
    if record.get("targetConfigCheckerPath") != str(checker) or record.get("targetConfigCheckerFileSha256") != checker_sha:
        fail("TARGET_HANDOFF_CHECKER_BINDING_MISMATCH", "target checker binding is invalid")
    attestation_sha = record.get("targetConfigAttestationSha256")
    if not isinstance(attestation_sha, str) or not legacy.SHA256.fullmatch(attestation_sha):
        fail("TARGET_HANDOFF_ATTESTATION_SHA_INVALID", "target attestation SHA-256 is invalid")
    expected_flags = {
        "failureReasonCode": None,
        "envMutationApplied": True,
        "rollbackVerified": False,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
        "terminal": False,
    }
    for field, expected in expected_flags.items():
        if record.get(field) != expected:
            fail("TARGET_HANDOFF_STATE_INVALID", f"handoff field {field} is invalid")
    fingerprint = record.get("handoffFingerprint")
    if not isinstance(fingerprint, str) or not legacy.SHA256.fullmatch(fingerprint):
        fail("TARGET_HANDOFF_FINGERPRINT_INVALID", "handoff fingerprint is invalid")
    body = dict(record)
    body.pop("handoffFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode("utf-8"))):
        fail("TARGET_HANDOFF_FINGERPRINT_MISMATCH", "handoff fingerprint does not match record")


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-executor", type=Path, default=root / "infra/backup/execute-backup-privacy-activation.py")
    parser.add_argument("--plan-checker", type=Path, default=root / "infra/backup/check-backup-privacy-activation-plan.py")
    parser.add_argument("--evidence-checker", type=Path, default=root / "infra/backup/backup-privacy-activation-execution.py")
    parser.add_argument("--target-config-checker", type=Path, default=root / "infra/backup/check-backup-privacy-target-config.py")
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--handoff", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        legacy = load_legacy(args.legacy_executor)
        key = legacy.read_key(args.key_file)
        verified = legacy.verify_plan(args.plan_checker, args.plan, args.key_file)
        plan = legacy.read_plan(args.plan, verified, args.env_file)
        directory = legacy.safe_execution_dir(args.pending, plan["activationId"])
        if args.handoff != directory / HANDOFF_FILE:
            fail("TARGET_HANDOFF_PATH_INVALID", "handoff path is not canonical for activation execution")
        for conflict in (
            "activation-target-handoff-rollback-started.json",
            "activation-target-handoff-rollback-verified.json",
            "activation-execution-completed.json",
            "activation-execution-rollback-started.json",
            "activation-execution-rollback-verified.json",
        ):
            if directory.joinpath(conflict).exists():
                fail("TARGET_HANDOFF_STATE_CONFLICT", f"conflicting evidence present: {conflict}")
        assessment = legacy.verify_pending(args.evidence_checker, args.plan_checker, args.plan, args.key_file, args.env_file, args.pending)
        if assessment.get("status") != "READY_TO_VALIDATE":
            fail("TARGET_HANDOFF_ENV_NOT_TARGET", "current env must equal signed target fingerprint")
        binding = legacy.marker_binding(plan, assessment, args.pending)
        checker_raw = legacy.read_regular_bytes(args.target_config_checker, "TARGET_CONFIGURATION_CHECKER")
        checker_sha = legacy.sha256_bytes(checker_raw)
        raw = legacy.read_regular_bytes(args.handoff, "TARGET_HANDOFF_MARKER")
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("TARGET_HANDOFF_INVALID: handoff is not JSON") from exc
        if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
            fail("TARGET_HANDOFF_INVALID", "handoff envelope is invalid")
        record = envelope["record"]
        validate_record(record, binding, args.target_config_checker, checker_sha, legacy)
        signature = envelope.get("signature")
        if not isinstance(signature, str) or not legacy.HMAC_SHA256.fullmatch(signature):
            fail("TARGET_HANDOFF_SIGNATURE_INVALID", "handoff signature is invalid")
        if not hmac.compare_digest(signature, expected_signature(record, key)):
            fail("TARGET_HANDOFF_SIGNATURE_MISMATCH", "handoff HMAC does not match")
        env_raw = legacy.read_regular_bytes(args.env_file, "ENV_FILE")
        if legacy.sha256_bytes(env_raw) != plan["targetEnvFingerprint"]:
            fail("TARGET_HANDOFF_ENV_DRIFT", "current env no longer equals target fingerprint")
        valid, digest, _ = target_config_attestation(legacy, args.target_config_checker, env_raw)
        if not valid:
            fail("TARGET_HANDOFF_REATTESTATION_FAILED", "current target configuration no longer validates")
        if not hmac.compare_digest(digest, record["targetConfigAttestationSha256"]):
            fail("TARGET_HANDOFF_ATTESTATION_DRIFT", "current target configuration evidence differs from signed handoff")
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_TARGET_HANDOFF_VERIFICATION",
            "status": "TARGET_HANDOFF_VERIFIED",
            "activationId": record["activationId"],
            "executionId": record["executionId"],
            "planFingerprint": record["planFingerprint"],
            "handoffFingerprint": record["handoffFingerprint"],
            "handoffFileSha256": legacy.sha256_bytes(raw),
            "targetConfigAttestationSha256": record["targetConfigAttestationSha256"],
            "targetEnvFingerprint": record["targetEnvFingerprint"],
            "serviceCutoverPlanningAllowed": True,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_TARGET_HANDOFF_VERIFICATION",
            "status": "BLOCKED",
            "blocker": blocker,
            "serviceCutoverPlanningAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
