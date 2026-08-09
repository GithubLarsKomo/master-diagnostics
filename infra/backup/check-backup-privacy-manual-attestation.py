#!/usr/bin/env python3
"""Verify a signed manual backup-privacy activation attestation without mutating runtime state."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import stat
import sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-manual-attestation:v1\n"
ATTESTATION_FILE = re.compile(r"^attestation-[0-9a-f]{32}\.json$")
ATTESTATION_ID = re.compile(r"^attestation-[0-9a-f]{32}$")
ATTESTOR_ID = re.compile(r"^[A-Za-z0-9._@:-]{1,128}$")
CANONICAL_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
TARGET = {
    "PRIVACY_BACKUP_STATE": "ENABLED",
    "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ATTESTATION_KEY_UNSAFE", "attestation key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ATTESTATION_KEY_INVALID: key is not valid Base64") from exc
    if len(key) != 32:
        fail("ATTESTATION_KEY_INVALID", "attestation key must decode to exactly 32 bytes")
    return key


def read_envelope(path: Path) -> dict[str, Any]:
    if not path.is_absolute():
        fail("ATTESTATION_PATH_NOT_ABSOLUTE", "attestation path must be absolute")
    if not ATTESTATION_FILE.fullmatch(path.name):
        fail("ATTESTATION_FILENAME_INVALID", "attestation filename is invalid")
    if path.is_symlink() or not path.is_file():
        fail("ATTESTATION_FILE_UNSAFE", "attestation must be a regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("ATTESTATION_PERMISSIONS_UNSAFE", "attestation must not be group/world accessible")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        fail("ATTESTATION_INVALID", "attestation envelope must be a JSON object")
    return raw


def verify_record(record: dict[str, Any]) -> None:
    required_true = (
        "rtoMet",
        "privacyReconciliationProven",
        "controlledPromotionProven",
        "operationalResponsibilityAcknowledged",
        "privacyBackupActivationAllowed",
    )
    if record.get("attestationVersion") != 1:
        fail("ATTESTATION_VERSION_INVALID", "attestationVersion must be 1")
    if not isinstance(record.get("attestationId"), str) or not ATTESTATION_ID.fullmatch(record["attestationId"]):
        fail("ATTESTATION_ID_INVALID", "attestation ID is invalid")
    if record.get("attestationScope") != "MANUAL_BACKUP_PRIVACY_CAPABILITY_ACTIVATION_APPROVAL":
        fail("ATTESTATION_SCOPE_INVALID", "attestation scope is invalid")
    if not isinstance(record.get("attestedAt"), str) or not CANONICAL_TS.fullmatch(record["attestedAt"]):
        fail("ATTESTED_AT_INVALID", "attestedAt is invalid")
    if not isinstance(record.get("attestorId"), str) or not ATTESTOR_ID.fullmatch(record["attestorId"]):
        fail("ATTESTOR_ID_INVALID", "attestor ID is invalid")
    if record.get("readinessVersion") != 1 or record.get("readinessStatus") != "READY_FOR_MANUAL_ATTESTATION":
        fail("READINESS_BINDING_INVALID", "attestation is not bound to readiness v1")
    if not isinstance(record.get("drillId"), str) or not re.fullmatch(r"drill-[0-9a-f]{32}", record["drillId"]):
        fail("DRILL_ID_INVALID", "drill ID is invalid")
    if not isinstance(record.get("drillReportFingerprint"), str) or not SHA256.fullmatch(record["drillReportFingerprint"]):
        fail("DRILL_REPORT_FINGERPRINT_INVALID", "drill report fingerprint is invalid")
    for key in required_true:
        if record.get(key) is not True:
            fail("ATTESTATION_POLICY_INVALID", f"{key} must be true")
    if record.get("activationTarget") != TARGET:
        fail("ATTESTATION_TARGET_INVALID", "activation target does not match backup privacy policy v1")
    if record.get("automaticActivationPerformed") is not False or record.get("runtimeConfigurationChanged") is not False:
        fail("ATTESTATION_BOUNDARY_INVALID", "manual attestation must not claim runtime mutation")
    fingerprint = record.get("attestationFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("ATTESTATION_FINGERPRINT_INVALID", "attestation fingerprint format is invalid")
    body = dict(record)
    body.pop("attestationFingerprint", None)
    expected = "sha256:" + hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    if not hmac.compare_digest(fingerprint, expected):
        fail("ATTESTATION_FINGERPRINT_MISMATCH", "attestation fingerprint does not match record content")


def verify_signature(envelope: dict[str, Any], key: bytes) -> dict[str, Any]:
    if envelope.get("envelopeVersion") != 1:
        fail("ATTESTATION_ENVELOPE_VERSION_INVALID", "envelopeVersion must be 1")
    record = envelope.get("record")
    signature = envelope.get("signature")
    if not isinstance(record, dict):
        fail("ATTESTATION_INVALID", "record is missing")
    verify_record(record)
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ATTESTATION_SIGNATURE_INVALID", "signature format is invalid")
    expected = "hmac-sha256:" + hmac.new(
        key,
        SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        fail("ATTESTATION_SIGNATURE_MISMATCH", "attestation HMAC verification failed")
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--attestation", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        record = verify_signature(read_envelope(args.attestation), read_key(args.key_file))
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_MANUAL_ATTESTATION_VERIFICATION",
            "status": "ATTESTATION_VERIFIED",
            "attestationId": record["attestationId"],
            "attestationFingerprint": record["attestationFingerprint"],
            "drillId": record["drillId"],
            "drillReportFingerprint": record["drillReportFingerprint"],
            "attestorId": record["attestorId"],
            "activationTarget": record["activationTarget"],
            "privacyBackupActivationAllowed": True,
            "runtimeConfigurationChanged": False,
            "automaticActivationPerformed": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_MANUAL_ATTESTATION_VERIFICATION",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "privacyBackupActivationAllowed": False,
            "runtimeConfigurationChanged": False,
            "automaticActivationPerformed": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
