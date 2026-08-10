#!/usr/bin/env python3
"""Persist signed online-update preparation evidence after release-note and pre-update-backup verification."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

ENVELOPE_VERSION = 1
PREPARATION_VERSION = 1
SIGNING_DOMAIN = b"masters:club-online-update-preparation:v1\n"
FILE_NAME = "online-update-preparation.json"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PREFIXED_SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
BACKUP_NAME_PATTERN = re.compile(r"^masters-backup-[0-9TZ]+-[0-9a-f-]{36}\.mdbak$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class PreparationError(ValueError):
    pass


def fail(message: str) -> None:
    raise PreparationError(message)


def load_selection_module():
    path = Path(__file__).with_name("persist-online-update-selection.py")
    spec = importlib.util.spec_from_file_location("master_diagnostics_online_update_selection", path)
    if spec is None or spec.loader is None:
        fail("Unable to load online update selection module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_regular_file(path: Path, label: str) -> bytes:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    return path.read_bytes()


def read_key(path: Path) -> bytes:
    raw = read_regular_file(path, "Online update preparation key")
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except (UnicodeDecodeError, ValueError) as exc:
        raise PreparationError("Online update preparation key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update preparation key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update preparation target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update preparation target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update preparation target must be a non-symlink directory")
    os.chmod(path, 0o700)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": ENVELOPE_VERSION, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def parse_timestamp(value: str, label: str) -> datetime:
    if not TIMESTAMP_PATTERN.fullmatch(value):
        fail(f"{label} timestamp is invalid")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PreparationError(f"{label} timestamp is invalid") from exc


def read_json(path: Path, label: str) -> Any:
    raw = read_regular_file(path, label)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreparationError(f"{label} is not valid UTF-8 JSON") from exc


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def validate_backup_verification(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("Backup verification output is invalid")
    required = {
        "ok", "fileName", "sha256", "bundleVersion", "createdAt", "consistency",
        "restoreReconciliationRequired",
    }
    if set(value) != required:
        fail("Backup verification output fields do not exactly match the canonical CLI contract")
    if value.get("ok") is not True:
        fail("Pre-update backup verification did not succeed")
    if not isinstance(value.get("fileName"), str) or not BACKUP_NAME_PATTERN.fullmatch(value["fileName"]):
        fail("Verified pre-update backup file name is invalid")
    if not isinstance(value.get("sha256"), str) or not SHA256_PATTERN.fullmatch(value["sha256"]):
        fail("Verified pre-update backup SHA-256 is invalid")
    if value.get("bundleVersion") != 1:
        fail("Verified pre-update backup bundle version is invalid")
    if value.get("consistency") != "CLEANLY_STOPPED_VOLUMES":
        fail("Verified pre-update backup consistency contract is invalid")
    if value.get("restoreReconciliationRequired") is not True:
        fail("Verified pre-update backup restore-reconciliation contract is invalid")
    if not isinstance(value.get("createdAt"), str):
        fail("Verified pre-update backup createdAt is invalid")
    parse_timestamp(value["createdAt"], "Verified pre-update backup")
    return value


def create_record(selection: dict[str, Any], release_notes: bytes, backup: dict[str, Any], backup_path: Path) -> dict[str, Any]:
    record = selection["record"]
    selected_at = record["selectedAt"]
    selected_dt = parse_timestamp(selected_at, "Online update selection")
    created_dt = parse_timestamp(backup["createdAt"], "Verified pre-update backup")
    if created_dt <= selected_dt:
        fail("Verified pre-update backup must be created strictly after selectedAt")

    expected_notes = record["releaseNotesSha256"]
    actual_notes = "sha256:" + sha256_bytes(release_notes)
    if expected_notes != actual_notes:
        fail("Release-notes bytes do not match selected manifest SHA-256")

    if backup_path.name != backup["fileName"]:
        fail("Verified pre-update backup file name does not match supplied bundle path")
    actual_backup_sha = sha256_bytes(read_regular_file(backup_path, "Pre-update backup bundle"))
    if actual_backup_sha != backup["sha256"]:
        fail("Current pre-update backup bytes do not match canonical verification SHA-256")

    return {
        "preparationVersion": PREPARATION_VERSION,
        "phase": "PREPARED",
        "selectionSignature": selection["signature"],
        "selectedAt": selected_at,
        "currentVersion": record["currentVersion"],
        "targetVersion": record["targetVersion"],
        "manifestFingerprint": record["manifestFingerprint"],
        "images": record["images"],
        "releaseNotes": {
            "sha256": actual_notes,
            "byteCount": len(release_notes),
            "verified": True,
        },
        "preUpdateBackup": {
            "fileName": backup["fileName"],
            "sha256": "sha256:" + backup["sha256"],
            "createdAt": backup["createdAt"],
            "bundleVersion": backup["bundleVersion"],
            "consistency": backup["consistency"],
            "restoreReconciliationRequired": backup["restoreReconciliationRequired"],
            "verified": True,
            "createdAfterSelection": True,
        },
        "backupPolicy": record["backupPolicy"],
        "rollbackPolicy": record["rollbackPolicy"],
        "releaseNotesBytesVerified": True,
        "preUpdateBackupVerified": True,
        "preUpdateBackupCreatedAfterSelection": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update preparation record is invalid")
    expected = {
        "preparationVersion", "phase", "selectionSignature", "selectedAt", "currentVersion",
        "targetVersion", "manifestFingerprint", "images", "releaseNotes", "preUpdateBackup",
        "backupPolicy", "rollbackPolicy", "releaseNotesBytesVerified", "preUpdateBackupVerified",
        "preUpdateBackupCreatedAfterSelection", "imagePullAllowed", "migrationAllowed",
        "productionMutationAllowed", "updateExecuted",
    }
    if set(record) != expected:
        fail("Online update preparation fields do not exactly match v1 contract")
    if record.get("preparationVersion") != 1 or record.get("phase") != "PREPARED":
        fail("Online update preparation version or phase is invalid")
    if not isinstance(record.get("selectionSignature"), str) or not HMAC_PATTERN.fullmatch(record["selectionSignature"]):
        fail("Online update preparation selection signature is invalid")
    if not isinstance(record.get("manifestFingerprint"), str) or not PREFIXED_SHA256_PATTERN.fullmatch(record["manifestFingerprint"]):
        fail("Online update preparation manifest fingerprint is invalid")
    parse_timestamp(record.get("selectedAt", ""), "Online update preparation selectedAt")
    notes = record.get("releaseNotes")
    if not isinstance(notes, dict) or set(notes) != {"sha256", "byteCount", "verified"}:
        fail("Online update preparation release-notes binding is invalid")
    if not isinstance(notes.get("sha256"), str) or not PREFIXED_SHA256_PATTERN.fullmatch(notes["sha256"]):
        fail("Online update preparation release-notes SHA-256 is invalid")
    if not isinstance(notes.get("byteCount"), int) or notes["byteCount"] < 0 or notes.get("verified") is not True:
        fail("Online update preparation release-notes evidence is invalid")
    backup = record.get("preUpdateBackup")
    if not isinstance(backup, dict) or set(backup) != {
        "fileName", "sha256", "createdAt", "bundleVersion", "consistency",
        "restoreReconciliationRequired", "verified", "createdAfterSelection",
    }:
        fail("Online update preparation backup binding is invalid")
    if not isinstance(backup.get("fileName"), str) or not BACKUP_NAME_PATTERN.fullmatch(backup["fileName"]):
        fail("Online update preparation backup file name is invalid")
    if not isinstance(backup.get("sha256"), str) or not PREFIXED_SHA256_PATTERN.fullmatch(backup["sha256"]):
        fail("Online update preparation backup SHA-256 is invalid")
    parse_timestamp(backup.get("createdAt", ""), "Online update preparation backup createdAt")
    if backup.get("bundleVersion") != 1 or backup.get("consistency") != "CLEANLY_STOPPED_VOLUMES":
        fail("Online update preparation backup contract is invalid")
    if backup.get("restoreReconciliationRequired") is not True or backup.get("verified") is not True or backup.get("createdAfterSelection") is not True:
        fail("Online update preparation backup safety evidence is invalid")
    if record.get("backupPolicy") != "VERIFIED_PREUPDATE_BACKUP_REQUIRED" or record.get("rollbackPolicy") != "RESTORE_VERIFIED_PREUPDATE_BACKUP":
        fail("Online update preparation backup/rollback policy is invalid")
    required_flags = {
        "releaseNotesBytesVerified": True,
        "preUpdateBackupVerified": True,
        "preUpdateBackupCreatedAfterSelection": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }
    for field, wanted in required_flags.items():
        if record.get(field) is not wanted:
            fail(f"Online update preparation safety flag {field} is invalid")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != ENVELOPE_VERSION:
        fail("Online update preparation envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update preparation signature is invalid")
    expected = sign_record(key, record)
    if not hmac.compare_digest(signature, expected):
        fail("Online update preparation signature verification failed")
    return {"envelopeVersion": 1, "record": record, "signature": signature}


def persist(target_dir: Path, key: bytes, record: dict[str, Any]) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Online update preparation evidence is not a regular non-symlink file")
        existing = verify_envelope(read_json(path, "Online update preparation evidence"), key)
        if existing["record"] != record:
            fail("Existing online update preparation does not match current verified inputs")
        return path, False, existing
    envelope = {"envelopeVersion": 1, "record": validate_record(record), "signature": sign_record(key, record)}
    serialized = json.dumps(envelope, indent=2, ensure_ascii=False) + "\n"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return persist(target_dir, key, record)
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
    parser.add_argument("--selection", required=True, type=Path)
    parser.add_argument("--selection-key", required=True, type=Path)
    parser.add_argument("--release-notes", required=True, type=Path)
    parser.add_argument("--backup-bundle", required=True, type=Path)
    parser.add_argument("--backup-verification", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        selection_module = load_selection_module()
        selection_key = selection_module.read_key(args.selection_key)
        selection = selection_module.verify_envelope(read_json(args.selection, "Online update selection"), selection_key)
        notes = read_regular_file(args.release_notes, "Release-notes file")
        backup = validate_backup_verification(read_json(args.backup_verification, "Backup verification output"))
        record = create_record(selection, notes, backup, args.backup_bundle)
        key = read_key(args.key_file)
        path, created, envelope = persist(args.target_dir, key, record)
    except (OSError, PreparationError, ValueError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1
    print(canonical_json({
        "mode": "CLUB_ONLINE_UPDATE_PREPARATION_V1",
        "status": "READY_FOR_IMMUTABLE_IMAGE_RESOLUTION",
        "preparationPath": str(path),
        "preparationCreated": created,
        "preparationReused": not created,
        "selectionSignature": envelope["record"]["selectionSignature"],
        "releaseNotesSha256": envelope["record"]["releaseNotes"]["sha256"],
        "backupFileName": envelope["record"]["preUpdateBackup"]["fileName"],
        "backupSha256": envelope["record"]["preUpdateBackup"]["sha256"],
        "backupCreatedAfterSelection": True,
        "backupVerified": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
