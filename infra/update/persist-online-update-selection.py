#!/usr/bin/env python3
"""Persist the operator-selected online update identity before a pre-update backup is created."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ENVELOPE_VERSION = 1
SELECTION_VERSION = 1
SIGNING_DOMAIN = b"masters:club-online-update-selection:v1\n"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
FILE_NAME = "online-update-selection.json"


class SelectionError(ValueError):
    pass


def fail(message: str) -> None:
    raise SelectionError(message)


def load_preflight_module():
    path = Path(__file__).with_name("preflight-online-update.py")
    spec = importlib.util.spec_from_file_location("master_diagnostics_online_update_preflight", path)
    if spec is None or spec.loader is None:
        fail("Unable to load online update preflight module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_key(path: Path) -> bytes:
    if not path.is_absolute():
        fail("Online update selection key path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail("Online update selection key must be a regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise SelectionError("Online update selection key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update selection key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update selection target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update selection target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update selection target must be a non-symlink directory")
    os.chmod(path, 0o700)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": ENVELOPE_VERSION, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def now_timestamp() -> str:
    now = datetime.now(timezone.utc)
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update selection record is invalid")
    expected_fields = {
        "selectionVersion", "phase", "selectedAt", "currentVersion", "targetVersion",
        "manifestFingerprint", "releaseNotesSha256", "images", "backupPolicy",
        "rollbackPolicy", "backupMustBeCreatedAfterSelectedAt", "operatorSelectionRequired",
        "imagePullAllowed", "migrationAllowed", "productionMutationAllowed", "updateExecuted",
    }
    if set(record) != expected_fields:
        fail("Online update selection fields do not exactly match v1 contract")
    if record.get("selectionVersion") != SELECTION_VERSION or record.get("phase") != "SELECTED":
        fail("Online update selection version or phase is invalid")
    selected_at = record.get("selectedAt")
    if not isinstance(selected_at, str) or not TIMESTAMP_PATTERN.fullmatch(selected_at):
        fail("Online update selection timestamp is invalid")
    try:
        datetime.fromisoformat(selected_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SelectionError("Online update selection timestamp is invalid") from exc
    if not isinstance(record.get("currentVersion"), str) or not isinstance(record.get("targetVersion"), str):
        fail("Online update selection versions are invalid")
    if not isinstance(record.get("manifestFingerprint"), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", record["manifestFingerprint"]):
        fail("Online update selection manifest fingerprint is invalid")
    if not isinstance(record.get("releaseNotesSha256"), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", record["releaseNotesSha256"]):
        fail("Online update selection release-notes fingerprint is invalid")
    images = record.get("images")
    if not isinstance(images, list) or [item.get("role") if isinstance(item, dict) else None for item in images] != ["APP", "MIGRATOR"]:
        fail("Online update selection image binding is invalid")
    if record.get("backupPolicy") != "VERIFIED_PREUPDATE_BACKUP_REQUIRED":
        fail("Online update selection backup policy is invalid")
    if record.get("rollbackPolicy") != "RESTORE_VERIFIED_PREUPDATE_BACKUP":
        fail("Online update selection rollback policy is invalid")
    required_flags = {
        "backupMustBeCreatedAfterSelectedAt": True,
        "operatorSelectionRequired": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }
    for field, expected in required_flags.items():
        if record.get(field) is not expected:
            fail(f"Online update selection safety flag {field} is invalid")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != ENVELOPE_VERSION:
        fail("Online update selection envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update selection signature is invalid")
    expected = sign_record(key, record)
    if not hmac.compare_digest(signature, expected):
        fail("Online update selection signature verification failed")
    return {"envelopeVersion": ENVELOPE_VERSION, "record": record, "signature": signature}


def expected_binding(preflight: dict[str, Any]) -> dict[str, Any]:
    return {
        "currentVersion": preflight["currentVersion"],
        "targetVersion": preflight["targetVersion"],
        "manifestFingerprint": preflight["manifestFingerprint"],
        "releaseNotesSha256": preflight["releaseNotes"]["sha256"],
        "images": preflight["images"],
        "backupPolicy": preflight["backupPolicy"],
        "rollbackPolicy": preflight["rollbackPolicy"],
    }


def assert_binding(record: dict[str, Any], binding: dict[str, Any]) -> None:
    for field, expected in binding.items():
        if record.get(field) != expected:
            fail(f"Existing online update selection does not match current preflight: {field}")


def create_record(preflight: dict[str, Any]) -> dict[str, Any]:
    binding = expected_binding(preflight)
    return validate_record({
        "selectionVersion": SELECTION_VERSION,
        "phase": "SELECTED",
        "selectedAt": now_timestamp(),
        **binding,
        "backupMustBeCreatedAfterSelectedAt": True,
        "operatorSelectionRequired": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    })


def persist_selection(target_dir: Path, key: bytes, preflight: dict[str, Any]) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    binding = expected_binding(preflight)
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Online update selection evidence is not a regular non-symlink file")
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SelectionError("Online update selection evidence is not valid JSON") from exc
        envelope = verify_envelope(existing, key)
        assert_binding(envelope["record"], binding)
        return path, False, envelope

    record = create_record(preflight)
    envelope = {"envelopeVersion": ENVELOPE_VERSION, "record": record, "signature": sign_record(key, record)}
    serialized = json.dumps(envelope, indent=2, ensure_ascii=False) + "\n"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return persist_selection(target_dir, key, preflight)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    os.chmod(path, 0o600)
    return path, True, envelope


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--current-version", required=True)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        preflight_module = load_preflight_module()
        manifest = preflight_module.read_json(args.manifest)
        preflight = preflight_module.validate_manifest(manifest, args.current_version)
        key = read_key(args.key_file)
        path, created, envelope = persist_selection(args.target_dir, key, preflight)
    except (OSError, SelectionError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps({
        "mode": "CLUB_ONLINE_UPDATE_SELECTION_V1",
        "status": "SELECTED_FOR_VERIFIED_BACKUP",
        "selectionPath": str(path),
        "selectionCreated": created,
        "selectionReused": not created,
        "selectedAt": envelope["record"]["selectedAt"],
        "manifestFingerprint": envelope["record"]["manifestFingerprint"],
        "selectionSignature": envelope["signature"],
        "backupMustBeCreatedAfterSelectedAt": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
