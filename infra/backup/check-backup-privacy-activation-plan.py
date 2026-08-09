#!/usr/bin/env python3
"""Verify a signed backup-privacy activation plan without mutating runtime configuration."""
from __future__ import annotations

import argparse, base64, hashlib, hmac, json, re, stat, sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-activation-plan:v1\n"
ACTIVATION_FILE = re.compile(r"^activation-[0-9a-f]{32}\.json$")
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
ATTESTATION_ID = re.compile(r"^attestation-[0-9a-f]{32}$")
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
        fail("ACTIVATION_PLAN_KEY_UNSAFE", "activation plan key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ACTIVATION_PLAN_KEY_INVALID: key is not valid Base64") from exc
    if len(key) != 32:
        fail("ACTIVATION_PLAN_KEY_INVALID", "activation plan key must decode to exactly 32 bytes")
    return key


def read_envelope(path: Path) -> dict[str, Any]:
    if not path.is_absolute() or not ACTIVATION_FILE.fullmatch(path.name):
        fail("ACTIVATION_PLAN_PATH_INVALID", "activation plan path or filename is invalid")
    if path.is_symlink() or not path.is_file():
        fail("ACTIVATION_PLAN_FILE_UNSAFE", "activation plan must be a regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("ACTIVATION_PLAN_PERMISSIONS_UNSAFE", "activation plan must not be group/world accessible")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        fail("ACTIVATION_PLAN_INVALID", "activation plan envelope must be a JSON object")
    return raw


def verify_record(record: dict[str, Any]) -> None:
    if record.get("activationPlanVersion") != 1:
        fail("ACTIVATION_PLAN_VERSION_INVALID", "activationPlanVersion must be 1")
    if not isinstance(record.get("activationId"), str) or not ACTIVATION_ID.fullmatch(record["activationId"]):
        fail("ACTIVATION_ID_INVALID", "activation ID is invalid")
    if not isinstance(record.get("attestationId"), str) or not ATTESTATION_ID.fullmatch(record["attestationId"]):
        fail("ATTESTATION_ID_INVALID", "attestation ID is invalid")
    for field in ("attestationFingerprint", "attestationFileSha256", "currentEnvFingerprint", "targetEnvFingerprint", "planFingerprint"):
        if not isinstance(record.get(field), str) or not SHA256.fullmatch(record[field]):
            fail("ACTIVATION_PLAN_FINGERPRINT_INVALID", f"{field} is invalid")
    if not isinstance(record.get("envFilePath"), str) or not record["envFilePath"].startswith("/"):
        fail("ACTIVATION_PLAN_ENV_PATH_INVALID", "envFilePath must be absolute")
    if record.get("activationTarget") != TARGET:
        fail("ACTIVATION_PLAN_TARGET_INVALID", "activation target does not match policy v1")
    if record.get("expectedPreState") != "DISABLED" or record.get("expectedPostState") != "ENABLED":
        fail("ACTIVATION_PLAN_STATE_INVALID", "activation state transition is invalid")
    for field in ("atomicReplaceRequired", "postWriteRuntimeAttestationRequired", "rollbackOnValidationFailureRequired"):
        if record.get(field) is not True:
            fail("ACTIVATION_PLAN_POLICY_INVALID", f"{field} must be true")
    if record.get("runtimeConfigurationChanged") is not False or record.get("activationExecuted") is not False:
        fail("ACTIVATION_PLAN_BOUNDARY_INVALID", "activation plan must be pre-mutation evidence")
    fp = record["planFingerprint"]
    body = dict(record); body.pop("planFingerprint", None)
    expected = "sha256:" + hashlib.sha256(canonical_json(body).encode()).hexdigest()
    if not hmac.compare_digest(fp, expected):
        fail("ACTIVATION_PLAN_FINGERPRINT_MISMATCH", "plan fingerprint does not match record content")


def verify_signature(envelope: dict[str, Any], key: bytes) -> dict[str, Any]:
    if envelope.get("envelopeVersion") != 1:
        fail("ACTIVATION_PLAN_ENVELOPE_VERSION_INVALID", "envelopeVersion must be 1")
    record = envelope.get("record"); signature = envelope.get("signature")
    if not isinstance(record, dict):
        fail("ACTIVATION_PLAN_INVALID", "record is missing")
    verify_record(record)
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("ACTIVATION_PLAN_SIGNATURE_INVALID", "signature format is invalid")
    expected = "hmac-sha256:" + hmac.new(
        key, SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        fail("ACTIVATION_PLAN_SIGNATURE_MISMATCH", "activation plan HMAC verification failed")
    return record


def main() -> int:
    p=argparse.ArgumentParser(); p.add_argument("--plan", required=True, type=Path); p.add_argument("--key-file", required=True, type=Path)
    args=p.parse_args()
    try:
        record=verify_signature(read_envelope(args.plan), read_key(args.key_file))
        print(json.dumps({
            "mode":"BACKUP_PRIVACY_ACTIVATION_PLAN_VERIFICATION",
            "status":"ACTIVATION_PLAN_VERIFIED",
            "activationId":record["activationId"],
            "planFingerprint":record["planFingerprint"],
            "currentEnvFingerprint":record["currentEnvFingerprint"],
            "targetEnvFingerprint":record["targetEnvFingerprint"],
            "envFilePath":record["envFilePath"],
            "activationTarget":record["activationTarget"],
            "activationExecutionAllowed":True,
            "runtimeConfigurationChanged":False,
            "activationExecuted":False,
        },separators=(",",":"),ensure_ascii=False)); return 0
    except (OSError,ValueError,json.JSONDecodeError) as exc:
        print(json.dumps({"mode":"BACKUP_PRIVACY_ACTIVATION_PLAN_VERIFICATION","status":"BLOCKED","blocker":str(exc).split(":",1)[0],"activationExecutionAllowed":False,"runtimeConfigurationChanged":False,"activationExecuted":False},separators=(",",":"))); return 1


if __name__ == "__main__": raise SystemExit(main())
