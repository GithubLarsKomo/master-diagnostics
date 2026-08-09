#!/usr/bin/env python3
"""Evaluate ENABLED backup-privacy target configuration without claiming live-process proof."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(
        ["pnpm", "--silent", "privacy-capabilities:check"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(json.dumps({
            "readyForIrreversibleProcessing": False,
            "backupState": "UNDECLARED",
            "attestationScope": "TARGET_CONFIGURATION_POLICY_ONLY",
            "liveRuntimeAttested": False,
            "activationExecuted": False,
            "blockers": ["TARGET_CONFIGURATION_CHECK_OUTPUT_INVALID"],
        }, separators=(",", ":")))
        return 1
    blockers = result.get("blockers")
    valid = (
        proc.returncode == 0
        and result.get("readyForIrreversibleProcessing") is True
        and result.get("backupState") == "ENABLED"
        and result.get("backupPolicyVersion") == "1.0.0"
        and blockers == []
    )
    result["attestationScope"] = "TARGET_CONFIGURATION_POLICY_ONLY"
    result["liveRuntimeAttested"] = False
    result["activationExecuted"] = False
    if not valid:
        current = blockers if isinstance(blockers, list) else []
        if "TARGET_CONFIGURATION_POLICY_INVALID" not in current:
            current = [*current, "TARGET_CONFIGURATION_POLICY_INVALID"]
        result["blockers"] = current
        result["readyForIrreversibleProcessing"] = False
    print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
