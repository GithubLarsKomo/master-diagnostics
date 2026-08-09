#!/usr/bin/env python3
"""Read-only verification for signed restore/RTO drill evidence."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:restore-rto-drill-report:v1\n"
REPORT_NAME = re.compile(r"^drill-[0-9a-f]{32}\.json$")
DRILL_ID = re.compile(r"^drill-[0-9a-f]{32}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
PHASES = [
    "VERIFY_BACKUP",
    "STAGE_RESTORE",
    "PRIVACY_REPLAY",
    "AUTHORIZE_PROMOTION",
    "PREPARE_PROMOTION_PLAN",
    "PREPARE_CANDIDATES",
    "AUTHORIZE_SWITCH",
    "EXECUTE_SWITCH",
]


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


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


def verify(path: Path, key_file: Path) -> dict[str, Any]:
    if not path.is_absolute() or not REPORT_NAME.fullmatch(path.name):
        fail("Restore RTO drill report path/name is invalid")
    if path.is_symlink() or not path.is_file():
        fail("Restore RTO drill report must be a regular non-symlink file")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("envelopeVersion") != 1:
        fail("Restore RTO drill report envelope version is invalid")
    record = raw.get("record")
    signature = raw.get("signature")
    if not isinstance(record, dict) or not isinstance(signature, str) or not HMAC.fullmatch(signature):
        fail("Restore RTO drill report envelope is invalid")
    if record.get("reportVersion") != 1 or record.get("executionScope") != "HOST_OPERATIONAL_RESTORE_RTO_DRILL":
        fail("Restore RTO drill report record version/scope is invalid")
    drill_id = record.get("drillId")
    if not isinstance(drill_id, str) or not DRILL_ID.fullmatch(drill_id) or f"{drill_id}.json" != path.name:
        fail("Restore RTO drill report filename does not match signed drill identity")
    fingerprint = record.get("reportFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("Restore RTO drill report fingerprint is invalid")
    without_fp = dict(record)
    without_fp.pop("reportFingerprint", None)
    expected_fp = "sha256:" + hashlib.sha256(canonical_json(without_fp).encode()).hexdigest()
    if fingerprint != expected_fp:
        fail("Restore RTO drill report fingerprint verification failed")
    payload = {"envelopeVersion": 1, "record": record}
    key = read_key(key_file)
    expected_sig = "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_sig):
        fail("Restore RTO drill report signature verification failed")

    phases = record.get("phases")
    if not isinstance(phases, list) or [item.get("name") for item in phases if isinstance(item, dict)] != PHASES:
        fail("Restore RTO drill report phase set/order is invalid")
    if record.get("rtoTargetSeconds") != 14400:
        fail("Restore RTO drill report RTO target is invalid")
    if record.get("privacyBackupActivationAllowed") is not False:
        fail("Restore RTO drill report crossed the activation boundary")

    successful = (
        record.get("status") == "COMPLETED"
        and record.get("rtoMet") is True
        and isinstance(record.get("durationSeconds"), int)
        and 0 <= record["durationSeconds"] <= 14400
        and record.get("terminalPhase") == "EXECUTE_SWITCH"
        and record.get("privacyReconciliationIncluded") is True
        and record.get("controlledPromotionIncluded") is True
        and all(
            isinstance(item, dict)
            and item.get("status") == "COMPLETED"
            and item.get("exitCode") == 0
            and isinstance(item.get("durationSeconds"), int)
            and item["durationSeconds"] >= 0
            for item in phases
        )
    )
    return {
        "mode": "RESTORE_RTO_DRILL_REPORT_VERIFICATION",
        "status": "DRILL_VERIFIED" if successful else "DRILL_NOT_SUCCESSFUL",
        "drillId": drill_id,
        "reportFingerprint": fingerprint,
        "signatureVerified": True,
        "restoreCompleted": record.get("status") == "COMPLETED",
        "rtoMet": record.get("rtoMet") is True,
        "rtoTargetSeconds": 14400,
        "durationSeconds": record.get("durationSeconds"),
        "privacyReconciliationIncluded": record.get("privacyReconciliationIncluded") is True,
        "controlledPromotionIncluded": record.get("controlledPromotionIncluded") is True,
        "activationReviewReady": successful,
        "activationApplied": False,
        "privacyBackupStateChanged": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    result = verify(args.report, args.key_file)
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["status"] == "DRILL_VERIFIED" else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=__import__("sys").stderr)
        raise SystemExit(1)
