#!/usr/bin/env python3
"""Independently verify signed restore/RTO drill reports."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:restore-rto-drill-report:v1\n"
CANONICAL_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
BUNDLE = re.compile(r"^masters-backup-[0-9TZ]+-[0-9a-f-]{36}\.mdbak$")
STAGING = re.compile(r"^restore-[0-9TZ]+-[0-9a-f-]{36}$")
CANDIDATE_SET = re.compile(r"^restore-[0-9a-f]{20}$")
DRILL_ID = re.compile(r"^drill-[0-9a-f]{32}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
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
RECORD_FIELDS = {
    "reportVersion",
    "drillId",
    "executionScope",
    "status",
    "bundleName",
    "bundleFingerprint",
    "stagingName",
    "candidateSetId",
    "startedAt",
    "completedAt",
    "durationSeconds",
    "rtoTargetSeconds",
    "rtoMet",
    "terminalPhase",
    "phases",
    "privacyReconciliationIncluded",
    "controlledPromotionIncluded",
    "privacyBackupActivationAllowed",
    "reportFingerprint",
}
PHASE_FIELDS = {"name", "status", "durationSeconds", "exitCode"}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def read_private(path: Path, code: str) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{code}_UNSAFE", "path must be an absolute regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode != 0o600:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file mode must be exactly 0600")
    return path.read_bytes()


def read_key(path: Path) -> bytes:
    raw = read_private(path, "RESTORE_RTO_DRILL_KEY")
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("RESTORE_RTO_DRILL_KEY_INVALID: key is not valid Base64") from exc
    if len(key) != 32:
        fail("RESTORE_RTO_DRILL_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def parse_timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not CANONICAL_TS.fullmatch(value):
        fail("RESTORE_RTO_DRILL_TIMESTAMP_INVALID", f"{field} must use canonical UTC milliseconds")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError(f"RESTORE_RTO_DRILL_TIMESTAMP_INVALID: {field} is invalid") from exc


def validate_optional_identifier(value: Any, pattern: re.Pattern[str], field: str) -> None:
    if value is not None and (not isinstance(value, str) or not pattern.fullmatch(value)):
        fail("RESTORE_RTO_DRILL_IDENTIFIER_INVALID", f"{field} is invalid")


def validate_phases(value: Any, overall_status: str, terminal_phase: Any, duration_seconds: int) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        fail("RESTORE_RTO_DRILL_PHASES_INVALID", "phases must be a non-empty array")
    if len(value) > len(PHASES):
        fail("RESTORE_RTO_DRILL_PHASES_INVALID", "too many phases")

    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != PHASE_FIELDS:
            fail("RESTORE_RTO_DRILL_PHASE_INVALID", f"phase {index + 1} has unexpected shape")
        name = item.get("name")
        status = item.get("status")
        phase_duration = item.get("durationSeconds")
        exit_code = item.get("exitCode")
        if name != PHASES[index]:
            fail("RESTORE_RTO_DRILL_PHASE_ORDER_INVALID", f"phase {index + 1} must be {PHASES[index]}")
        if status not in {"COMPLETED", "FAILED"}:
            fail("RESTORE_RTO_DRILL_PHASE_STATUS_INVALID", f"phase {name} has invalid status")
        if not isinstance(phase_duration, int) or isinstance(phase_duration, bool) or phase_duration < 0:
            fail("RESTORE_RTO_DRILL_PHASE_DURATION_INVALID", f"phase {name} duration is invalid")
        if not isinstance(exit_code, int) or isinstance(exit_code, bool) or exit_code < 0 or exit_code > 255:
            fail("RESTORE_RTO_DRILL_PHASE_EXIT_INVALID", f"phase {name} exit code is invalid")
        if status == "COMPLETED" and exit_code != 0:
            fail("RESTORE_RTO_DRILL_PHASE_EXIT_INVALID", f"completed phase {name} must exit 0")
        if status == "FAILED" and exit_code == 0:
            fail("RESTORE_RTO_DRILL_PHASE_EXIT_INVALID", f"failed phase {name} must exit non-zero")
        result.append({
            "name": name,
            "status": status,
            "durationSeconds": phase_duration,
            "exitCode": exit_code,
        })

    if terminal_phase != result[-1]["name"]:
        fail("RESTORE_RTO_DRILL_TERMINAL_PHASE_MISMATCH", "terminalPhase must equal the last recorded phase")
    if sum(item["durationSeconds"] for item in result) > duration_seconds:
        fail("RESTORE_RTO_DRILL_DURATION_INCONSISTENT", "phase durations exceed total duration")

    failed_indexes = [index for index, item in enumerate(result) if item["status"] == "FAILED"]
    if overall_status == "COMPLETED":
        if len(result) != len(PHASES) or failed_indexes:
            fail("RESTORE_RTO_DRILL_COMPLETION_INVALID", "COMPLETED requires all eight phases completed")
    elif overall_status == "ROLLED_BACK":
        if len(result) != len(PHASES) or failed_indexes != [len(PHASES) - 1]:
            fail("RESTORE_RTO_DRILL_ROLLBACK_INVALID", "ROLLED_BACK requires only EXECUTE_SWITCH to be failed")
    elif overall_status == "FAILED":
        if failed_indexes != [len(result) - 1]:
            fail("RESTORE_RTO_DRILL_FAILURE_INVALID", "FAILED requires exactly the terminal recorded phase to be failed")
    else:
        fail("RESTORE_RTO_DRILL_STATUS_INVALID", "report status is invalid")
    return result


def verify_record(record: dict[str, Any], report_path: Path, expected_bundle_name: str | None, expected_bundle_sha256: str | None) -> dict[str, Any]:
    if set(record) != RECORD_FIELDS:
        fail("RESTORE_RTO_DRILL_RECORD_SHAPE_INVALID", "record fields differ from report v1 contract")
    if record.get("reportVersion") != 1:
        fail("RESTORE_RTO_DRILL_VERSION_INVALID", "reportVersion must be 1")
    if record.get("executionScope") != "HOST_OPERATIONAL_RESTORE_RTO_DRILL":
        fail("RESTORE_RTO_DRILL_SCOPE_INVALID", "executionScope is invalid")

    drill_id = record.get("drillId")
    if not isinstance(drill_id, str) or not DRILL_ID.fullmatch(drill_id) or report_path.name != f"{drill_id}.json":
        fail("RESTORE_RTO_DRILL_ID_INVALID", "drillId or report filename is invalid")

    bundle_name = record.get("bundleName")
    bundle_fingerprint = record.get("bundleFingerprint")
    if not isinstance(bundle_name, str) or not BUNDLE.fullmatch(bundle_name):
        fail("RESTORE_RTO_DRILL_BUNDLE_INVALID", "bundleName is invalid")
    if not isinstance(bundle_fingerprint, str) or not SHA256.fullmatch(bundle_fingerprint):
        fail("RESTORE_RTO_DRILL_BUNDLE_INVALID", "bundleFingerprint is invalid")
    if expected_bundle_name is not None and bundle_name != expected_bundle_name:
        fail("RESTORE_RTO_DRILL_BUNDLE_MISMATCH", "report is bound to a different backup bundle")
    if expected_bundle_sha256 is not None:
        if not SHA256.fullmatch(expected_bundle_sha256):
            fail("RESTORE_RTO_DRILL_EXPECTED_BUNDLE_FINGERPRINT_INVALID", "expected bundle fingerprint is invalid")
        if bundle_fingerprint != expected_bundle_sha256:
            fail("RESTORE_RTO_DRILL_BUNDLE_MISMATCH", "report bundle fingerprint differs from expected backup bytes")

    validate_optional_identifier(record.get("stagingName"), STAGING, "stagingName")
    validate_optional_identifier(record.get("candidateSetId"), CANDIDATE_SET, "candidateSetId")

    started = parse_timestamp(record.get("startedAt"), "startedAt")
    completed = parse_timestamp(record.get("completedAt"), "completedAt")
    duration = record.get("durationSeconds")
    if not isinstance(duration, int) or isinstance(duration, bool) or duration < 0:
        fail("RESTORE_RTO_DRILL_DURATION_INVALID", "durationSeconds is invalid")
    if completed < started or int((completed - started).total_seconds()) != duration:
        fail("RESTORE_RTO_DRILL_DURATION_INCONSISTENT", "timestamps and durationSeconds differ")

    if record.get("rtoTargetSeconds") != 14400:
        fail("RESTORE_RTO_DRILL_RTO_TARGET_INVALID", "rtoTargetSeconds must be 14400")
    status = record.get("status")
    if status not in {"COMPLETED", "ROLLED_BACK", "FAILED"}:
        fail("RESTORE_RTO_DRILL_STATUS_INVALID", "status is invalid")
    expected_rto = status == "COMPLETED" and duration <= 14400
    if record.get("rtoMet") is not expected_rto:
        fail("RESTORE_RTO_DRILL_RTO_FLAG_INVALID", "rtoMet is inconsistent with status/duration")
    if record.get("privacyBackupActivationAllowed") is not False:
        fail("RESTORE_RTO_DRILL_ACTIVATION_BOUNDARY_INVALID", "report must never authorize backup privacy activation")

    phases = validate_phases(record.get("phases"), status, record.get("terminalPhase"), duration)
    reconciliation = any(item["name"] == "PRIVACY_REPLAY" and item["status"] == "COMPLETED" for item in phases)
    promotion = any(item["name"] == "EXECUTE_SWITCH" and item["status"] == "COMPLETED" for item in phases)
    if record.get("privacyReconciliationIncluded") is not reconciliation:
        fail("RESTORE_RTO_DRILL_RECONCILIATION_FLAG_INVALID", "privacyReconciliationIncluded is inconsistent")
    if record.get("controlledPromotionIncluded") is not promotion:
        fail("RESTORE_RTO_DRILL_PROMOTION_FLAG_INVALID", "controlledPromotionIncluded is inconsistent")

    if status in {"COMPLETED", "ROLLED_BACK"}:
        if record.get("stagingName") is None or record.get("candidateSetId") is None:
            fail("RESTORE_RTO_DRILL_TERMINAL_BINDING_MISSING", "terminal switch reports require stagingName and candidateSetId")
    if status == "COMPLETED" and (not reconciliation or not promotion):
        fail("RESTORE_RTO_DRILL_COMPLETION_INVALID", "completed drill lacks reconciliation or controlled promotion")

    fingerprint = record.get("reportFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("RESTORE_RTO_DRILL_FINGERPRINT_INVALID", "reportFingerprint is invalid")
    body = dict(record)
    body.pop("reportFingerprint")
    expected_fingerprint = sha256_bytes(canonical_json(body).encode("utf-8"))
    if not hmac.compare_digest(fingerprint, expected_fingerprint):
        fail("RESTORE_RTO_DRILL_FINGERPRINT_MISMATCH", "reportFingerprint does not match record")

    return {
        "drillId": drill_id,
        "drillStatus": status,
        "reportFingerprint": fingerprint,
        "bundleName": bundle_name,
        "bundleFingerprint": bundle_fingerprint,
        "durationSeconds": duration,
        "rtoMet": expected_rto,
        "privacyReconciliationIncluded": reconciliation,
        "controlledPromotionIncluded": promotion,
        "practicalRestoreEvidenceVerified": status == "COMPLETED" and expected_rto and reconciliation and promotion,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--expected-bundle-name")
    parser.add_argument("--expected-bundle-sha256")
    parser.add_argument("--require-completed", action="store_true")
    parser.add_argument("--require-rto-met", action="store_true")
    args = parser.parse_args()

    try:
        raw = read_private(args.report, "RESTORE_RTO_DRILL_REPORT")
        key = read_key(args.key_file)
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("RESTORE_RTO_DRILL_REPORT_INVALID: report is not JSON") from exc
        if not isinstance(envelope, dict) or set(envelope) != {"envelopeVersion", "record", "signature"}:
            fail("RESTORE_RTO_DRILL_REPORT_SHAPE_INVALID", "report envelope is invalid")
        if envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
            fail("RESTORE_RTO_DRILL_REPORT_SHAPE_INVALID", "report envelope version/record is invalid")
        signature = envelope.get("signature")
        if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
            fail("RESTORE_RTO_DRILL_REPORT_SIGNATURE_INVALID", "report signature is invalid")
        signed_payload = {"envelopeVersion": 1, "record": envelope["record"]}
        expected_signature = "hmac-sha256:" + hmac.new(
            key,
            SIGNING_DOMAIN + canonical_json(signed_payload).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(signature, expected_signature):
            fail("RESTORE_RTO_DRILL_REPORT_SIGNATURE_MISMATCH", "report HMAC does not match")

        verified = verify_record(
            envelope["record"],
            args.report,
            args.expected_bundle_name,
            args.expected_bundle_sha256,
        )
        if args.require_completed and verified["drillStatus"] != "COMPLETED":
            fail("RESTORE_RTO_DRILL_COMPLETION_REQUIRED", "a completed drill is required")
        if args.require_rto_met and verified["rtoMet"] is not True:
            fail("RESTORE_RTO_DRILL_RTO_REQUIRED", "the four-hour RTO target must be met")

        print(json.dumps({
            "mode": "RESTORE_RTO_DRILL_REPORT_VERIFICATION",
            "status": "RESTORE_RTO_DRILL_REPORT_VERIFIED",
            **verified,
            "rtoTargetSeconds": 14400,
            "privacyBackupActivationAllowed": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "RESTORE_RTO_DRILL_REPORT_VERIFICATION",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "practicalRestoreEvidenceVerified": False,
            "privacyBackupActivationAllowed": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
