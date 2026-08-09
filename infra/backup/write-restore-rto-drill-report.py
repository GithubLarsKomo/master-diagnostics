#!/usr/bin/env python3
"""Persist a technical, signed restore/RTO drill report without authorizing backup activation."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:restore-rto-drill-report:v1\n"
CANONICAL_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
BUNDLE = re.compile(r"^masters-backup-[0-9TZ]+-[0-9a-f-]{36}\.mdbak$")
STAGING = re.compile(r"^restore-[0-9TZ]+-[0-9a-f-]{36}$")
CANDIDATE_SET = re.compile(r"^restore-[0-9a-f]{20}$")
DRILL_ID = re.compile(r"^drill-[0-9a-f]{32}$")
PHASES = (
    "VERIFY_BACKUP",
    "STAGE_RESTORE",
    "PRIVACY_REPLAY",
    "AUTHORIZE_PROMOTION",
    "PREPARE_PROMOTION_PLAN",
    "PREPARE_CANDIDATES",
    "AUTHORIZE_SWITCH",
    "EXECUTE_SWITCH",
)


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("Restore RTO drill report key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Restore RTO drill report key is not valid Base64") from exc
    if len(key) != 32:
        fail("Restore RTO drill report key must decode to exactly 32 bytes")
    return key


def read_phases(path: Path) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        fail("Restore RTO drill phases must be a JSON array")
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            fail("Restore RTO drill phase entry is invalid")
        name = item.get("name")
        status = item.get("status")
        duration = item.get("durationSeconds")
        exit_code = item.get("exitCode")
        if name not in PHASES or name in seen:
            fail("Restore RTO drill phase name/order is invalid")
        if status not in ("COMPLETED", "FAILED", "NOT_RUN"):
            fail("Restore RTO drill phase status is invalid")
        if not isinstance(duration, int) or duration < 0:
            fail("Restore RTO drill phase duration is invalid")
        if not isinstance(exit_code, int) or exit_code < 0 or exit_code > 255:
            fail("Restore RTO drill phase exit code is invalid")
        seen.add(name)
        result.append({"name": name, "status": status, "durationSeconds": duration, "exitCode": exit_code})
    indexes = [PHASES.index(item["name"]) for item in result]
    if indexes != sorted(indexes):
        fail("Restore RTO drill phase order is invalid")
    return result


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--drill-id", required=True)
    parser.add_argument("--bundle-name", required=True)
    parser.add_argument("--bundle-sha256", required=True)
    parser.add_argument("--staging-name", default="")
    parser.add_argument("--candidate-set-id", default="")
    parser.add_argument("--started-at", required=True)
    parser.add_argument("--completed-at", required=True)
    parser.add_argument("--duration-seconds", required=True, type=int)
    parser.add_argument("--status", required=True, choices=("COMPLETED", "ROLLED_BACK", "FAILED"))
    parser.add_argument("--terminal-phase", required=True)
    parser.add_argument("--phases-file", required=True, type=Path)
    args = parser.parse_args()

    if not args.output_dir.is_absolute():
        fail("Restore RTO drill report directory must be absolute")
    if not DRILL_ID.fullmatch(args.drill_id):
        fail("Restore RTO drill ID is invalid")
    if not BUNDLE.fullmatch(args.bundle_name):
        fail("Restore RTO drill bundle name is invalid")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.bundle_sha256):
        fail("Restore RTO drill bundle fingerprint is invalid")
    if args.staging_name and not STAGING.fullmatch(args.staging_name):
        fail("Restore RTO drill staging name is invalid")
    if args.candidate_set_id and not CANDIDATE_SET.fullmatch(args.candidate_set_id):
        fail("Restore RTO drill candidate-set ID is invalid")
    if not CANONICAL_TS.fullmatch(args.started_at) or not CANONICAL_TS.fullmatch(args.completed_at):
        fail("Restore RTO drill timestamps must be canonical UTC timestamps")
    if args.completed_at < args.started_at:
        fail("Restore RTO drill completion cannot precede start")
    if args.duration_seconds < 0:
        fail("Restore RTO drill duration is invalid")
    if args.terminal_phase not in PHASES:
        fail("Restore RTO drill terminal phase is invalid")

    phases = read_phases(args.phases_file)
    key = read_key(args.key_file)
    args.output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.output_dir.is_symlink() or not args.output_dir.is_dir():
        fail("Restore RTO drill report directory is unsafe")
    os.chmod(args.output_dir, 0o700)

    record = {
        "reportVersion": 1,
        "drillId": args.drill_id,
        "executionScope": "HOST_OPERATIONAL_RESTORE_RTO_DRILL",
        "status": args.status,
        "bundleName": args.bundle_name,
        "bundleFingerprint": args.bundle_sha256,
        "stagingName": args.staging_name or None,
        "candidateSetId": args.candidate_set_id or None,
        "startedAt": args.started_at,
        "completedAt": args.completed_at,
        "durationSeconds": args.duration_seconds,
        "rtoTargetSeconds": 14400,
        "rtoMet": args.status == "COMPLETED" and args.duration_seconds <= 14400,
        "terminalPhase": args.terminal_phase,
        "phases": phases,
        "privacyReconciliationIncluded": any(p["name"] == "PRIVACY_REPLAY" and p["status"] == "COMPLETED" for p in phases),
        "controlledPromotionIncluded": any(p["name"] == "EXECUTE_SWITCH" and p["status"] == "COMPLETED" for p in phases),
        "privacyBackupActivationAllowed": False,
    }
    fingerprint = "sha256:" + hashlib.sha256(canonical_json(record).encode()).hexdigest()
    payload = {"envelopeVersion": 1, "record": {**record, "reportFingerprint": fingerprint}}
    signature = "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode(), hashlib.sha256).hexdigest()
    envelope = {**payload, "signature": signature}

    output = args.output_dir / f"{args.drill_id}.json"
    serialized = json.dumps(envelope, indent=2, ensure_ascii=False) + "\n"
    if output.exists():
        if output.is_symlink() or not output.is_file():
            fail("Existing restore RTO drill report path is unsafe")
        if output.read_text(encoding="utf-8") != serialized:
            fail("Restore RTO drill report already exists with different content")
    else:
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
    os.chmod(output, 0o600)
    print(json.dumps({
        "mode": "RESTORE_RTO_DRILL_REPORT",
        "status": args.status,
        "drillId": args.drill_id,
        "reportPath": str(output),
        "reportFingerprint": fingerprint,
        "signature": signature,
        "durationSeconds": args.duration_seconds,
        "rtoTargetSeconds": 14400,
        "rtoMet": record["rtoMet"],
        "privacyBackupActivationAllowed": False,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=os.sys.stderr)
        raise SystemExit(1)
