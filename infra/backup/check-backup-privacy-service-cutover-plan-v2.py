#!/usr/bin/env python3
"""Verify signed service cutover plan v2 bound to TARGET_HANDOFF_VERIFIED evidence."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import stat
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-service-cutover-plan:v2\n"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CUTOVER_ID = re.compile(r"^cutover-[0-9a-f]{32}$")
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


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_private(path: Path, code: str) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{code}_UNSAFE", "file must be absolute regular non-symlink")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must be private")
    return path.read_bytes()


def read_key(path: Path) -> bytes:
    try:
        key = base64.b64decode(read_private(path, "SERVICE_CUTOVER_KEY").decode().strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("SERVICE_CUTOVER_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("SERVICE_CUTOVER_KEY_INVALID", "key must decode to 32 bytes")
    return key


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        raw = read_private(args.plan, "SERVICE_CUTOVER_PLAN")
        envelope = json.loads(raw)
        if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
            fail("SERVICE_CUTOVER_PLAN_INVALID", "envelope invalid")
        record = envelope["record"]
        if record.get("serviceCutoverPlanVersion") != 2:
            fail("SERVICE_CUTOVER_PLAN_VERSION_INVALID", "plan v2 required")
        cutover_id = record.get("cutoverId")
        if not isinstance(cutover_id, str) or not CUTOVER_ID.fullmatch(cutover_id) or args.plan.name != f"{cutover_id}.v2.json":
            fail("SERVICE_CUTOVER_ID_INVALID", "cutover ID/path invalid")
        for field in (
            "activationPlanFileSha256", "pendingEvidenceFileSha256", "targetHandoffFingerprint",
            "targetHandoffFileSha256", "targetConfigAttestationSha256", "activationPlanFingerprint",
            "targetEnvFingerprint", "composeFileSha256", "renderedComposeSha256",
        ):
            if not isinstance(record.get(field), str) or not SHA256.fullmatch(record[field]):
                fail("SERVICE_CUTOVER_BINDING_INVALID", f"{field} invalid")
        if record.get("requiredPrivacyEnvironment") != TARGET:
            fail("SERVICE_CUTOVER_TARGET_INVALID", "privacy target invalid")
        if record.get("preflightService") != "privacy-check":
            fail("SERVICE_CUTOVER_SERVICE_POLICY_INVALID", "preflight service invalid")
        if record.get("recreateServices") != ["app", "export-cleanup", "retention-scan"]:
            fail("SERVICE_CUTOVER_SERVICE_POLICY_INVALID", "recreate service set invalid")
        if record.get("preserveServices") != ["libsql", "caddy"]:
            fail("SERVICE_CUTOVER_SERVICE_POLICY_INVALID", "preserve service set invalid")
        for field in (
            "targetHandoffRequiredBeforePlanning", "targetHandoffIsNonterminal",
            "preflightMustSucceedBeforeMutation", "renderedComposeMustRemainBound",
            "caddyContainerMustBePreserved", "libsqlContainerMustBePreserved",
            "liveBaselineRequiredBeforeMutation", "appHealthcheckRequired",
            "backgroundServicesRunningRequired", "liveRuntimeEnvironmentAttestationRequired",
            "liveRuntimeCompletionRequiredAfterCutover", "rollbackOnCutoverFailureRequired",
        ):
            if record.get(field) is not True:
                fail("SERVICE_CUTOVER_POLICY_INVALID", f"{field} must be true")
        if record.get("serviceCutoverExecuted") is not False or record.get("liveRuntimeAttested") is not False or record.get("activationExecuted") is not False:
            fail("SERVICE_CUTOVER_STATE_INVALID", "plan must remain read-only pre-cutover")
        fingerprint = record.get("cutoverPlanFingerprint")
        if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
            fail("SERVICE_CUTOVER_FINGERPRINT_INVALID", "fingerprint invalid")
        body = dict(record)
        body.pop("cutoverPlanFingerprint")
        if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode())):
            fail("SERVICE_CUTOVER_FINGERPRINT_MISMATCH", "fingerprint mismatch")
        signature = envelope.get("signature")
        key = read_key(args.key_file)
        expected = "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode(), hashlib.sha256).hexdigest()
        if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature) or not hmac.compare_digest(signature, expected):
            fail("SERVICE_CUTOVER_SIGNATURE_MISMATCH", "HMAC mismatch")
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN_V2_CHECK",
            "status": "SERVICE_CUTOVER_PLAN_VERIFIED",
            "cutoverId": cutover_id,
            "activationId": record.get("activationId"),
            "cutoverPlanFingerprint": fingerprint,
            "serviceCutoverExecutionAllowed": True,
            "liveBaselineRequiredBeforeMutation": True,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":")))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN_V2_CHECK",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
