#!/usr/bin/env python3
"""Read-only verifier for signed non-terminal backup-privacy live-runtime handoff evidence."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def load_module(path: Path, name: str):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("LIVE_HANDOFF_MODULE_UNSAFE", f"{name} module must be an absolute regular non-symlink file")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        fail("LIVE_HANDOFF_MODULE_INVALID", f"could not load {name} module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify(args: argparse.Namespace) -> dict[str, Any]:
    executor = load_module(args.executor, "backup_privacy_activation_executor")
    handoff = load_module(args.handoff_module, "backup_privacy_live_handoff")
    key = executor.read_key(args.key_file)
    verified = executor.verify_plan(args.plan_checker, args.plan, args.key_file)
    plan = executor.read_plan(args.plan, verified, args.env_file)
    directory = executor.safe_execution_dir(args.pending, plan["activationId"])
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
    completed, rollback_started, rollback_verified = handoff.terminal_markers(executor, directory, binding, key)
    if completed is not None:
        fail("LIVE_HANDOFF_TERMINAL_COMPLETION_CONFLICT", "terminal file-activation completion exists instead of non-terminal handoff")
    if rollback_started is not None or rollback_verified is not None:
        fail("LIVE_HANDOFF_ROLLBACK_CONFLICT", "activation is already in rollback direction")
    handoff_path = directory / handoff.HANDOFF_FILE
    envelope = handoff.read_handoff(handoff_path, binding, key, executor)
    if envelope is None:
        fail("LIVE_HANDOFF_MISSING", "signed live-runtime handoff evidence is missing")
    raw = executor.read_regular_bytes(args.env_file, "ENV_FILE")
    actual = executor.sha256_bytes(raw)
    if actual != plan["targetEnvFingerprint"]:
        fail("LIVE_HANDOFF_ENV_DRIFT", "handoff requires the exact signed target env fingerprint")
    return {
        "mode": "BACKUP_PRIVACY_LIVE_HANDOFF_VERIFICATION",
        "status": "LIVE_HANDOFF_VERIFIED",
        "activationId": binding["activationId"],
        "executionId": binding["executionId"],
        "executionFingerprint": binding["executionFingerprint"],
        "planFingerprint": binding["planFingerprint"],
        "envFilePath": binding["envFilePath"],
        "currentEnvFingerprint": binding["currentEnvFingerprint"],
        "targetEnvFingerprint": binding["targetEnvFingerprint"],
        "actualEnvFingerprint": actual,
        "handoffPath": str(handoff_path),
        "handoffFileSha256": executor.sha256_bytes(handoff_path.read_bytes()),
        "handoffFingerprint": envelope["record"]["handoffFingerprint"],
        "handoffSignature": envelope["signature"],
        "staticPolicyAttestationSha256": envelope["record"]["staticPolicyAttestationSha256"],
        "handoffReasonCode": envelope["record"]["handoffReasonCode"],
        "serviceCutoverPlanningAllowed": True,
        "runtimeConfigurationChanged": True,
        "activationExecuted": False,
        "liveRuntimeAttested": False,
    }


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--executor", type=Path, default=root / "infra/backup/execute-backup-privacy-activation.py")
    parser.add_argument("--handoff-module", type=Path, default=root / "infra/backup/stage-backup-privacy-live-handoff.py")
    parser.add_argument("--plan-checker", type=Path, default=root / "infra/backup/check-backup-privacy-activation-plan.py")
    parser.add_argument("--evidence-checker", type=Path, default=root / "infra/backup/backup-privacy-activation-execution.py")
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--pending", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_LIVE_HANDOFF_VERIFICATION",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "serviceCutoverPlanningAllowed": False,
            "runtimeConfigurationChanged": False,
            "activationExecuted": False,
            "liveRuntimeAttested": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
