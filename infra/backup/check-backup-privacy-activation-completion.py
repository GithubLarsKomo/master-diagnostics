#!/usr/bin/env python3
"""Read-only authentication of #226 COMPLETED evidence across later live cutover/rollback states."""
from __future__ import annotations

import argparse
import importlib.util
import json
import stat
import sys
from pathlib import Path
from typing import Any


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def load_executor(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_EXECUTOR_MODULE_UNSAFE", "executor module must be an absolute regular non-symlink file")
    spec = importlib.util.spec_from_file_location("backup_privacy_activation_executor", path)
    if spec is None or spec.loader is None:
        fail("ACTIVATION_EXECUTOR_MODULE_INVALID", "could not load activation executor module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def authenticate(args: argparse.Namespace) -> dict[str, Any]:
    module = load_executor(args.executor)
    key = module.read_key(args.key_file)
    verified = module.verify_plan(args.plan_checker, args.plan, args.key_file)
    plan = module.read_plan(args.plan, verified, args.env_file)
    directory = module.safe_execution_dir(args.pending, plan["activationId"])
    assessment = module.verify_pending(
        args.evidence_checker,
        args.plan_checker,
        args.plan,
        args.key_file,
        args.env_file,
        args.pending,
    )
    if assessment.get("activationId") != plan["activationId"] or assessment.get("planFingerprint") != plan["planFingerprint"]:
        fail("ACTIVATION_COMPLETION_PENDING_MISMATCH", "PENDING evidence does not match activation plan")
    binding = module.marker_binding(plan, assessment, args.pending)
    completed_path = directory / module.MARKER_FILES["COMPLETED"]
    rollback_started_path = directory / module.MARKER_FILES["ROLLBACK_STARTED"]
    rollback_verified_path = directory / module.MARKER_FILES["ROLLBACK_VERIFIED"]
    completed = module.read_marker(completed_path, "COMPLETED", binding, key)
    rollback_started = module.read_marker(rollback_started_path, "ROLLBACK_STARTED", binding, key)
    rollback_verified = module.read_marker(rollback_verified_path, "ROLLBACK_VERIFIED", binding, key)
    if completed is None:
        fail("ACTIVATION_COMPLETION_MISSING", "signed COMPLETED marker is required")
    if rollback_started is not None or rollback_verified is not None:
        fail("ACTIVATION_COMPLETION_CONFLICT", "completed file activation cannot also contain rollback evidence")
    raw = module.read_regular_bytes(args.env_file, "ENV_FILE")
    actual = module.sha256_bytes(raw)
    if actual == plan["targetEnvFingerprint"]:
        env_state = "TARGET"
    elif actual == plan["currentEnvFingerprint"]:
        env_state = "PRE_ACTIVATION"
    else:
        env_state = "DRIFT"
    if stat.S_IMODE(completed_path.stat().st_mode) & 0o077:
        fail("ACTIVATION_COMPLETION_PERMISSIONS_UNSAFE", "completed marker must be private")
    return {
        "mode": "BACKUP_PRIVACY_ACTIVATION_COMPLETION_AUTHENTICATION",
        "status": "ACTIVATION_COMPLETION_AUTHENTICATED",
        "activationId": plan["activationId"],
        "executionId": binding["executionId"],
        "executionFingerprint": binding["executionFingerprint"],
        "planFingerprint": plan["planFingerprint"],
        "envFilePath": plan["envFilePath"],
        "currentEnvFingerprint": plan["currentEnvFingerprint"],
        "targetEnvFingerprint": plan["targetEnvFingerprint"],
        "actualEnvFingerprint": actual,
        "envState": env_state,
        "completionMarkerPath": str(completed_path),
        "completionMarkerSha256": module.sha256_bytes(completed_path.read_bytes()),
        "completionMarkerSignature": completed["signature"],
        "runtimeAttestationSha256": completed["record"]["runtimeAttestationSha256"],
        "runtimeCutoverAllowed": env_state == "TARGET",
        "fileActivationExecuted": True,
        "liveRuntimeActivationVerified": False,
    }


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--executor", type=Path, default=root / "infra/backup/execute-backup-privacy-activation.py")
    parser.add_argument("--plan-checker", type=Path, default=root / "infra/backup/check-backup-privacy-activation-plan.py")
    parser.add_argument("--evidence-checker", type=Path, default=root / "infra/backup/backup-privacy-activation-execution.py")
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = authenticate(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_COMPLETION_AUTHENTICATION",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "runtimeCutoverAllowed": False,
            "fileActivationExecuted": False,
            "liveRuntimeActivationVerified": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
