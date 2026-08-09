#!/usr/bin/env python3
"""Fail closed for legacy pre-cutover activation completion evidence.

A target .env plus a static helper-process policy check is not proof that the
running Club services adopted ENABLED. Service-cutover planning must consume
the signed nonterminal TARGET_HANDOFF_VERIFIED chain instead.
"""
from __future__ import annotations

import argparse
import json


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan-checker", required=True)
    parser.add_argument("--evidence-checker", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--pending", required=True)
    parser.add_argument("--completion", required=True)
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--env-file", required=True)
    parser.parse_args()
    print(json.dumps({
        "mode": "BACKUP_PRIVACY_ACTIVATION_COMPLETION_CHECK",
        "status": "BLOCKED",
        "blocker": "LIVE_RUNTIME_COMPLETION_REQUIRED",
        "serviceCutoverPlanningAllowed": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }, separators=(",", ":")))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
