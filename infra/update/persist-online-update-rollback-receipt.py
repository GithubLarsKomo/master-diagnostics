#!/usr/bin/env python3
"""Persist a signed online-update rollback receipt bound to a verified restore completion."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

ENVELOPE_VERSION = 1
RECEIPT_VERSION = 1
FILE_NAME = "online-update-rollback-receipt.json"
SIGNING_DOMAIN = b"masters:club-online-update-rollback-receipt:v1\n"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

RESTORE_VERIFY_FIELDS = {
    "mode", "status", "receiptVersion", "receiptSignature", "completedAt",
    "journalFingerprint", "journalSignature", "candidateSetId", "candidateSetFingerprint",
    "candidateSelectedEventSignature", "sourceProvenanceBindingSignature",
    "sourceProvenanceBindingFingerprint", "sourceProvenanceSignature", "sourceStagingName",
    "sourceBackupFileName", "sourceBackupSha256", "sourceBackupCreatedAt",
    "sourceBackupManifestFingerprint", "postSwitchHealthcheckFingerprint", "currentVolumeSet",
    "libsqlHealth", "appHealth", "exportCleanupRunning", "retentionScanRunning", "caddyPreserved",
    "rollbackVolumesRetained", "productionMutationCompleted", "promotionExecuted",
}


class RollbackReceiptError(ValueError):
    pass


def fail(message: str) -> None:
    raise RollbackReceiptError(message)


def load_module(file_name: str, module_name: str):
    path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        fail(f"Unable to load {file_name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_json(path: Path, label: str) -> Any:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RollbackReceiptError(f"{label} is not valid JSON") from exc


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("Online update rollback-receipt key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise RollbackReceiptError("Online update rollback-receipt key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update rollback-receipt key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update rollback-receipt target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update rollback-receipt target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update rollback-receipt target must be a non-symlink directory")
    os.chmod(path, 0o700)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": ENVELOPE_VERSION, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def unsigned_record(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key != "receiptFingerprint"}


def fingerprint_record(record: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(unsigned_record(record)).encode("utf-8")).hexdigest()


def validate_restore_verification(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != RESTORE_VERIFY_FIELDS:
        fail("Restore completion verification fields do not exactly match the expected contract")
    if value.get("mode") != "RESTORE_PROMOTION_SWITCH_COMPLETION_RECEIPT_VERIFICATION" or value.get("status") != "VERIFIED":
        fail("Restore completion receipt is not independently verified")
    if value.get("productionMutationCompleted") is not True or value.get("promotionExecuted") is not True:
        fail("Restore completion receipt does not prove completed promotion")
    for field in (
        "receiptSignature", "journalSignature", "candidateSelectedEventSignature",
        "sourceProvenanceBindingSignature", "sourceProvenanceSignature",
    ):
        if not isinstance(value.get(field), str) or not HMAC_PATTERN.fullmatch(value[field]):
            fail(f"Restore completion verification {field} is invalid")
    for field in (
        "journalFingerprint", "candidateSetFingerprint", "sourceProvenanceBindingFingerprint",
        "sourceBackupSha256", "sourceBackupManifestFingerprint", "postSwitchHealthcheckFingerprint",
    ):
        if not isinstance(value.get(field), str) or not SHA256_PATTERN.fullmatch(value[field]):
            fail(f"Restore completion verification {field} is invalid")
    for field in ("completedAt", "sourceBackupCreatedAt"):
        if not isinstance(value.get(field), str) or not TIMESTAMP_PATTERN.fullmatch(value[field]):
            fail(f"Restore completion verification {field} is invalid")
    if not isinstance(value.get("sourceBackupFileName"), str) or not value["sourceBackupFileName"]:
        fail("Restore completion verification source backup file name is invalid")
    return value


def verify_restore_completion(args: argparse.Namespace) -> dict[str, Any]:
    repo_root = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    env.update({
        "RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE": str(args.restore_switch_intent),
        "RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE": str(args.restore_switch_journal),
        "RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_DIR": str(args.restore_switch_execution_dir),
        "RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE": str(args.restore_promotion_key),
    })
    command = [
        "pnpm", "--silent", "--filter", "@masters/db",
        "backup:restore-promotion-switch-completion-receipt-verify",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RollbackReceiptError("Restore completion receipt verifier could not be executed") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or "verification failed"
        fail(f"Restore completion receipt verifier failed: {detail}")
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        fail("Restore completion receipt verifier must emit exactly one JSON line")
    try:
        value = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise RollbackReceiptError("Restore completion receipt verifier output is not valid JSON") from exc
    return validate_restore_verification(value)


def create_record(journal: dict[str, Any], rollback_started: dict[str, Any], restore: dict[str, Any], recorded_at: str) -> dict[str, Any]:
    if not TIMESTAMP_PATTERN.fullmatch(recorded_at):
        fail("Online update rollback-receipt recordedAt must be canonical UTC ISO-8601")
    journal_record = journal["record"]
    rollback_record = rollback_started["record"]
    anchor = journal_record["rollbackAnchor"]
    if rollback_record.get("phase") != "ROLLBACK_STARTED" or rollback_record.get("rollbackStarted") is not True:
        fail("Online update rollback receipt requires ROLLBACK_STARTED as current execution event")
    if rollback_record.get("terminal") is not False or rollback_record.get("updateExecuted") is not False:
        fail("Online update rollback receipt requires non-terminal rollback-start evidence")
    if recorded_at < rollback_record["recordedAt"]:
        fail("Online update rollback-receipt recordedAt cannot precede ROLLBACK_STARTED")
    if restore["completedAt"] > recorded_at:
        fail("Online update rollback-receipt cannot precede restore completion")
    if (
        restore["sourceBackupFileName"] != anchor["fileName"]
        or restore["sourceBackupSha256"] != anchor["sha256"]
        or restore["sourceBackupCreatedAt"] != anchor["createdAt"]
    ):
        fail("Verified restore completion does not match the journal-bound pre-update rollback backup")
    record: dict[str, Any] = {
        "receiptVersion": RECEIPT_VERSION,
        "phase": "VERIFIED_RESTORE_ROLLBACK",
        "recordedAt": recorded_at,
        "onlineUpdateJournalSignature": journal["signature"],
        "rollbackStartedEventSignature": rollback_started["signature"],
        "targetVersion": journal_record["targetVersion"],
        "rollbackBackupFileName": anchor["fileName"],
        "rollbackBackupSha256": anchor["sha256"],
        "rollbackBackupCreatedAt": anchor["createdAt"],
        "restoreCompletionReceiptSignature": restore["receiptSignature"],
        "restoreCompletedAt": restore["completedAt"],
        "restoreSourceProvenanceBindingSignature": restore["sourceProvenanceBindingSignature"],
        "restoreSourceProvenanceBindingFingerprint": restore["sourceProvenanceBindingFingerprint"],
        "restoreSourceProvenanceSignature": restore["sourceProvenanceSignature"],
        "restoreSourceStagingName": restore["sourceStagingName"],
        "restoreCandidateSetId": restore["candidateSetId"],
        "restoreCandidateSetFingerprint": restore["candidateSetFingerprint"],
        "restorePostSwitchHealthcheckFingerprint": restore["postSwitchHealthcheckFingerprint"],
        "rollbackReceiptRequiredBeforeRollbackCompleted": True,
        "rollbackCompleted": False,
        "updateExecuted": False,
    }
    record["receiptFingerprint"] = fingerprint_record(record)
    return validate_record(record)


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update rollback-receipt record is invalid")
    expected = {
        "receiptVersion", "phase", "recordedAt", "onlineUpdateJournalSignature",
        "rollbackStartedEventSignature", "targetVersion", "rollbackBackupFileName", "rollbackBackupSha256",
        "rollbackBackupCreatedAt", "restoreCompletionReceiptSignature", "restoreCompletedAt",
        "restoreSourceProvenanceBindingSignature", "restoreSourceProvenanceBindingFingerprint",
        "restoreSourceProvenanceSignature", "restoreSourceStagingName", "restoreCandidateSetId",
        "restoreCandidateSetFingerprint", "restorePostSwitchHealthcheckFingerprint",
        "rollbackReceiptRequiredBeforeRollbackCompleted", "rollbackCompleted", "updateExecuted",
        "receiptFingerprint",
    }
    if set(record) != expected:
        fail("Online update rollback-receipt fields do not exactly match v1 contract")
    if record.get("receiptVersion") != 1 or record.get("phase") != "VERIFIED_RESTORE_ROLLBACK":
        fail("Online update rollback-receipt version or phase is invalid")
    for field in ("recordedAt", "rollbackBackupCreatedAt", "restoreCompletedAt"):
        if not isinstance(record.get(field), str) or not TIMESTAMP_PATTERN.fullmatch(record[field]):
            fail(f"Online update rollback-receipt {field} is invalid")
    for field in (
        "onlineUpdateJournalSignature", "rollbackStartedEventSignature", "restoreCompletionReceiptSignature",
        "restoreSourceProvenanceBindingSignature", "restoreSourceProvenanceSignature",
    ):
        if not isinstance(record.get(field), str) or not HMAC_PATTERN.fullmatch(record[field]):
            fail(f"Online update rollback-receipt {field} is invalid")
    for field in (
        "rollbackBackupSha256", "restoreSourceProvenanceBindingFingerprint",
        "restoreCandidateSetFingerprint", "restorePostSwitchHealthcheckFingerprint", "receiptFingerprint",
    ):
        if not isinstance(record.get(field), str) or not SHA256_PATTERN.fullmatch(record[field]):
            fail(f"Online update rollback-receipt {field} is invalid")
    for field in ("targetVersion", "rollbackBackupFileName", "restoreSourceStagingName", "restoreCandidateSetId"):
        if not isinstance(record.get(field), str) or not record[field]:
            fail(f"Online update rollback-receipt {field} is invalid")
    if record.get("rollbackReceiptRequiredBeforeRollbackCompleted") is not True:
        fail("Online update rollback-receipt must be required before ROLLBACK_COMPLETED")
    if record.get("rollbackCompleted") is not False or record.get("updateExecuted") is not False:
        fail("Online update rollback-receipt cannot claim terminal rollback or successful update")
    if fingerprint_record(record) != record["receiptFingerprint"]:
        fail("Online update rollback-receipt fingerprint does not match its content")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != ENVELOPE_VERSION:
        fail("Online update rollback-receipt envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update rollback-receipt signature is invalid")
    if not hmac.compare_digest(signature, sign_record(key, record)):
        fail("Online update rollback-receipt signature verification failed")
    return {"envelopeVersion": ENVELOPE_VERSION, "record": record, "signature": signature}


def persist(target_dir: Path, key: bytes, record: dict[str, Any]) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Online update rollback-receipt evidence is not a regular non-symlink file")
        existing = verify_envelope(read_json(path, "Online update rollback receipt"), key)
        if existing["record"] != record:
            fail("Existing online update rollback receipt does not match the requested verified rollback")
        return path, False, existing
    envelope = {"envelopeVersion": ENVELOPE_VERSION, "record": validate_record(record), "signature": sign_record(key, record)}
    serialized = (json.dumps(envelope, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return persist(target_dir, key, record)
    try:
        with os.fdopen(fd, "wb") as handle:
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
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--event-key", required=True, type=Path)
    parser.add_argument("--restore-switch-intent", required=True, type=Path)
    parser.add_argument("--restore-switch-journal", required=True, type=Path)
    parser.add_argument("--restore-switch-execution-dir", required=True, type=Path)
    parser.add_argument("--restore-promotion-key", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--recorded-at", required=True)
    args = parser.parse_args()
    try:
        journal_module = load_module("persist-online-update-execution-journal.py", "master_diagnostics_online_update_execution_journal")
        event_module = load_module("persist-online-update-execution-event.py", "master_diagnostics_online_update_execution_event")
        journal_value, _ = journal_module.read_json_bytes(args.journal, "Online update execution journal")
        journal = journal_module.verify_envelope(journal_value, journal_module.read_key(args.journal_key))
        event_key = event_module.read_key(args.event_key)
        events = event_module.read_events(args.events_dir, event_key, journal)
        if not events or events[-1]["record"]["phase"] != "ROLLBACK_STARTED":
            fail("Online update rollback receipt requires ROLLBACK_STARTED as the latest verified event")
        rollback_started = events[-1]
        restore = verify_restore_completion(args)
        record = create_record(journal, rollback_started, restore, args.recorded_at)
        key = read_key(args.key_file)
        path, created, envelope = persist(args.target_dir, key, record)
    except (OSError, RollbackReceiptError, ValueError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1
    print(canonical_json({
        "mode": "CLUB_ONLINE_UPDATE_ROLLBACK_RECEIPT_V1",
        "status": "VERIFIED_RESTORE_ROLLBACK",
        "receiptPath": str(path),
        "receiptCreated": created,
        "receiptReused": not created,
        "receiptSignature": envelope["signature"],
        "receiptFingerprint": envelope["record"]["receiptFingerprint"],
        "rollbackStartedEventSignature": envelope["record"]["rollbackStartedEventSignature"],
        "rollbackBackupFileName": envelope["record"]["rollbackBackupFileName"],
        "rollbackBackupSha256": envelope["record"]["rollbackBackupSha256"],
        "restoreCompletionReceiptSignature": envelope["record"]["restoreCompletionReceiptSignature"],
        "rollbackReceiptRequiredBeforeRollbackCompleted": True,
        "rollbackCompleted": False,
        "updateExecuted": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
