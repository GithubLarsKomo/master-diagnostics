#!/usr/bin/env python3
"""Read-only gate for considering backup privacy capability activation after a real RTO drill."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:restore-rto-drill-report:v1\n"
DRILL_FILE = re.compile(r"^drill-[0-9a-f]{32}\.json$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CANONICAL_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
EXPECTED_PHASES = (
    "VERIFY_BACKUP",
    "STAGE_RESTORE",
    "PRIVACY_REPLAY",
    "AUTHORIZE_PROMOTION",
    "PREPARE_PROMOTION_PLAN",
    "PREPARE_CANDIDATES",
    "AUTHORIZE_SWITCH",
    "EXECUTE_SWITCH",
)
RTO_TARGET_SECONDS = 14_400


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("DRILL_REPORT_KEY_UNSAFE", "drill report key must be an absolute regular non-symlink file")
    encoded = path.read_text(encoding="utf-8").strip()
    try:
        key = base64.b64decode(encoded, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("DRILL_REPORT_KEY_INVALID: drill report key is not valid Base64") from exc
    if len(key) != 32:
        fail("DRILL_REPORT_KEY_INVALID", "drill report key must decode to exactly 32 bytes")
    return key


def read_report(path: Path) -> dict[str, Any]:
    if not path.is_absolute():
        fail("DRILL_REPORT_PATH_NOT_ABSOLUTE", "drill report path must be absolute")
    if not DRILL_FILE.fullmatch(path.name):
        fail("DRILL_REPORT_FILENAME_INVALID", "drill report file name is invalid")
    if path.is_symlink() or not path.is_file():
        fail("DRILL_REPORT_UNSAFE", "drill report must be a regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        fail("DRILL_REPORT_PERMISSIONS_UNSAFE", "drill report must not be group/world accessible")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        fail("DRILL_REPORT_INVALID", "drill report envelope must be a JSON object")
    return raw


def verify_report(envelope: dict[str, Any], key: bytes) -> dict[str, Any]:
    if envelope.get("envelopeVersion") != 1:
        fail("DRILL_REPORT_VERSION_INVALID", "drill report envelopeVersion must be 1")
    record = envelope.get("record")
    signature = envelope.get("signature")
    if not isinstance(record, dict):
        fail("DRILL_REPORT_INVALID", "drill report record is missing")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("DRILL_REPORT_SIGNATURE_INVALID", "drill report signature format is invalid")

    report_fingerprint = record.get("reportFingerprint")
    if not isinstance(report_fingerprint, str) or not SHA256.fullmatch(report_fingerprint):
        fail("DRILL_REPORT_FINGERPRINT_INVALID", "drill report fingerprint format is invalid")
    record_without_fingerprint = dict(record)
    record_without_fingerprint.pop("reportFingerprint", None)
    expected_fingerprint = "sha256:" + hashlib.sha256(canonical_json(record_without_fingerprint).encode()).hexdigest()
    if not hmac.compare_digest(report_fingerprint, expected_fingerprint):
        fail("DRILL_REPORT_FINGERPRINT_MISMATCH", "drill report fingerprint does not match record content")

    payload = {"envelopeVersion": 1, "record": record}
    expected_signature = "hmac-sha256:" + hmac.new(
        key,
        SIGNING_DOMAIN + canonical_json(payload).encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        fail("DRILL_REPORT_SIGNATURE_MISMATCH", "drill report HMAC verification failed")
    return record


def validate_activation_evidence(record: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if record.get("reportVersion") != 1:
        blockers.append("DRILL_REPORT_RECORD_VERSION_INVALID")
    if record.get("executionScope") != "HOST_OPERATIONAL_RESTORE_RTO_DRILL":
        blockers.append("DRILL_NOT_HOST_OPERATIONAL")
    if record.get("status") != "COMPLETED":
        blockers.append("DRILL_NOT_COMPLETED")
    if record.get("terminalPhase") != "EXECUTE_SWITCH":
        blockers.append("DRILL_DID_NOT_REACH_SWITCH")
    if record.get("durationSeconds") is None or not isinstance(record.get("durationSeconds"), int):
        blockers.append("DRILL_DURATION_INVALID")
    elif record["durationSeconds"] > RTO_TARGET_SECONDS:
        blockers.append("RTO_TARGET_NOT_MET")
    if record.get("rtoTargetSeconds") != RTO_TARGET_SECONDS or record.get("rtoMet") is not True:
        blockers.append("RTO_TARGET_NOT_MET")
    if record.get("privacyReconciliationIncluded") is not True:
        blockers.append("PRIVACY_RECONCILIATION_NOT_PROVEN")
    if record.get("controlledPromotionIncluded") is not True:
        blockers.append("CONTROLLED_PROMOTION_NOT_PROVEN")
    if record.get("privacyBackupActivationAllowed") is not False:
        blockers.append("DRILL_REPORT_AUTHORIZATION_BOUNDARY_INVALID")
    started = record.get("startedAt")
    completed = record.get("completedAt")
    if not isinstance(started, str) or not CANONICAL_TS.fullmatch(started):
        blockers.append("DRILL_START_TIMESTAMP_INVALID")
    if not isinstance(completed, str) or not CANONICAL_TS.fullmatch(completed):
        blockers.append("DRILL_COMPLETION_TIMESTAMP_INVALID")
    if isinstance(started, str) and isinstance(completed, str) and completed < started:
        blockers.append("DRILL_TIME_ORDER_INVALID")

    phases = record.get("phases")
    if not isinstance(phases, list) or [item.get("name") for item in phases if isinstance(item, dict)] != list(EXPECTED_PHASES):
        blockers.append("DRILL_PHASE_SEQUENCE_INCOMPLETE")
    else:
        for item in phases:
            if not isinstance(item, dict) or item.get("status") != "COMPLETED" or item.get("exitCode") != 0:
                blockers.append("DRILL_PHASE_NOT_SUCCESSFUL")
                break
    return sorted(set(blockers))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()

    current_state = os.environ.get("PRIVACY_BACKUP_STATE", "").strip()
    blockers: list[str] = []
    if current_state != "DISABLED":
        blockers.append("BACKUP_CAPABILITY_NOT_DISABLED_DURING_READINESS_REVIEW")

    try:
        key = read_key(args.key_file)
        record = verify_report(read_report(args.report), key)
        blockers.extend(validate_activation_evidence(record))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        message = str(exc)
        code = message.split(":", 1)[0] if ":" in message else "DRILL_REPORT_VERIFICATION_FAILED"
        blockers.append(code)
        record = None

    blockers = sorted(set(blockers))
    ready = not blockers
    output = {
        "mode": "BACKUP_PRIVACY_ACTIVATION_READINESS",
        "status": "READY_FOR_MANUAL_ATTESTATION" if ready else "BLOCKED",
        "readinessVersion": 1,
        "currentPrivacyBackupState": current_state or None,
        "drillReportVerified": record is not None,
        "drillId": record.get("drillId") if record else None,
        "reportFingerprint": record.get("reportFingerprint") if record else None,
        "rtoMet": record.get("rtoMet") if record else False,
        "privacyReconciliationProven": record.get("privacyReconciliationIncluded") if record else False,
        "controlledPromotionProven": record.get("controlledPromotionIncluded") if record else False,
        "blockers": blockers,
        "automaticActivationPerformed": False,
        "privacyBackupActivationAllowed": False,
        "manualAttestationTarget": {
            "PRIVACY_BACKUP_STATE": "ENABLED",
            "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
            "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
            "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
            "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
        } if ready else None,
    }
    print(json.dumps(output, separators=(",", ":"), ensure_ascii=False))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
