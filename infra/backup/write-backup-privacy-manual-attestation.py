#!/usr/bin/env python3
"""Create a signed manual backup-privacy activation attestation from verified drill readiness."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-manual-attestation:v1\n"
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
    encoded = path.read_text(encoding="utf-8").strip()
    try:
        key = base64.b64decode(encoded, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ATTESTATION_KEY_INVALID: key is not valid Base64") from exc
    if len(key) != 32:
        fail("ATTESTATION_KEY_INVALID", "attestation key must decode to exactly 32 bytes")
    return key


def safe_output_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("ATTESTATION_OUTPUT_NOT_ABSOLUTE", "output directory must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("ATTESTATION_OUTPUT_UNSAFE", "output directory must be a regular directory")
    os.chmod(path, 0o700)


def run_readiness(checker: Path, report: Path, drill_key: Path) -> dict[str, Any]:
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("READINESS_CHECKER_UNSAFE", "readiness checker must be an absolute regular non-symlink file")
    env = dict(os.environ)
    env["PRIVACY_BACKUP_STATE"] = "DISABLED"
    proc = subprocess.run(
        [sys.executable, str(checker), "--report", str(report), "--key-file", str(drill_key)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("READINESS_OUTPUT_INVALID: readiness checker did not return JSON") from exc
    if proc.returncode != 0 or result.get("status") != "READY_FOR_MANUAL_ATTESTATION":
        blockers = result.get("blockers") if isinstance(result, dict) else None
        fail("READINESS_NOT_MET", f"backup privacy activation readiness is blocked: {blockers}")
    if result.get("manualAttestationTarget") != TARGET:
        fail("READINESS_TARGET_MISMATCH", "readiness target does not match backup privacy policy v1")
    if result.get("privacyBackupActivationAllowed") is not False or result.get("automaticActivationPerformed") is not False:
        fail("READINESS_BOUNDARY_INVALID", "readiness output crossed the activation boundary")
    report_fingerprint = result.get("reportFingerprint")
    if not isinstance(report_fingerprint, str) or not SHA256.fullmatch(report_fingerprint):
        fail("READINESS_REPORT_FINGERPRINT_INVALID", "readiness report fingerprint is invalid")
    return result


def build_record(args: argparse.Namespace, readiness: dict[str, Any]) -> dict[str, Any]:
    if not ATTESTATION_ID.fullmatch(args.attestation_id):
        fail("ATTESTATION_ID_INVALID", "attestation ID must be attestation-<32 hex>")
    if not ATTESTOR_ID.fullmatch(args.attestor_id):
        fail("ATTESTOR_ID_INVALID", "attestor ID contains unsupported characters")
    if not CANONICAL_TS.fullmatch(args.attested_at):
        fail("ATTESTED_AT_INVALID", "attested-at must be canonical UTC ISO-8601 with milliseconds")
    if args.acknowledge_operational_responsibility is not True:
        fail("OPERATIONAL_ACKNOWLEDGEMENT_REQUIRED", "manual operational responsibility acknowledgement is required")
    record: dict[str, Any] = {
        "attestationVersion": 1,
        "attestationId": args.attestation_id,
        "attestationScope": "MANUAL_BACKUP_PRIVACY_CAPABILITY_ACTIVATION_APPROVAL",
        "attestedAt": args.attested_at,
        "attestorId": args.attestor_id,
        "drillId": readiness["drillId"],
        "drillReportFingerprint": readiness["reportFingerprint"],
        "readinessVersion": readiness["readinessVersion"],
        "readinessStatus": readiness["status"],
        "rtoMet": True,
        "privacyReconciliationProven": True,
        "controlledPromotionProven": True,
        "operationalResponsibilityAcknowledged": True,
        "activationTarget": TARGET,
        "automaticActivationPerformed": False,
        "runtimeConfigurationChanged": False,
        "privacyBackupActivationAllowed": True,
    }
    fingerprint_body = dict(record)
    record["attestationFingerprint"] = "sha256:" + hashlib.sha256(
        canonical_json(fingerprint_body).encode("utf-8")
    ).hexdigest()
    return record


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(
        key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256
    ).hexdigest()


def persist(output_dir: Path, envelope: dict[str, Any]) -> tuple[Path, bool]:
    path = output_dir / f"{envelope['record']['attestationId']}.json"
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("ATTESTATION_FILE_UNSAFE", "existing attestation path is unsafe")
        if path.read_text(encoding="utf-8") == serialized:
            return path, False
        fail("ATTESTATION_CONFLICT", "attestation ID already exists with different content")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    return path, True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--readiness-checker", required=True, type=Path)
    parser.add_argument("--drill-report", required=True, type=Path)
    parser.add_argument("--drill-key-file", required=True, type=Path)
    parser.add_argument("--attestation-key-file", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--attestation-id", required=True)
    parser.add_argument("--attestor-id", required=True)
    parser.add_argument("--attested-at", required=True)
    parser.add_argument("--acknowledge-operational-responsibility", action="store_true")
    args = parser.parse_args()

    try:
        readiness = run_readiness(args.readiness_checker, args.drill_report, args.drill_key_file)
        key = read_key(args.attestation_key_file)
        safe_output_dir(args.output_dir)
        record = build_record(args, readiness)
        envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(record, key)}
        if not HMAC_SHA256.fullmatch(envelope["signature"]):
            fail("ATTESTATION_SIGNATURE_INVALID", "generated attestation signature is invalid")
        path, created = persist(args.output_dir, envelope)
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_MANUAL_ATTESTATION_WRITER",
            "status": "ATTESTATION_PERSISTED",
            "attestationPath": str(path),
            "attestationCreated": created,
            "attestationReused": not created,
            "attestationId": record["attestationId"],
            "attestationFingerprint": record["attestationFingerprint"],
            "runtimeConfigurationChanged": False,
            "automaticActivationPerformed": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
