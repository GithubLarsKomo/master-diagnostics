#!/usr/bin/env python3
"""Persist the immutable rollback plan for an online update after ROLLBACK_STARTED."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
from pathlib import Path
from typing import Any

ENVELOPE_VERSION = 1
PLAN_VERSION = 1
FILE_NAME = "online-update-rollback-plan.json"
SIGNING_DOMAIN = b"masters:club-online-update-rollback-plan:v1\n"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
DOCKER_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
EXPECTED_WRITERS = ["app", "export-cleanup", "retention-scan"]


class RollbackPlanError(ValueError):
    pass


def fail(message: str) -> None:
    raise RollbackPlanError(message)


def load_module(file_name: str, module_name: str):
    path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        fail(f"Unable to load {module_name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_json(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def read_json(path: Path, label: str) -> Any:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RollbackPlanError(f"{label} is not valid UTF-8 JSON") from exc


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("Online update rollback-plan key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise RollbackPlanError("Online update rollback-plan key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update rollback-plan key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update rollback-plan target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update rollback-plan target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update rollback-plan target must be a non-symlink directory")
    os.chmod(path, 0o700)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def validate_backup(value: Any) -> dict[str, Any]:
    expected = {"fileName", "sha256", "createdAt", "verified", "rollbackAnchor"}
    if not isinstance(value, dict) or set(value) != expected:
        fail("Online update rollback plan backup anchor is invalid")
    if value.get("verified") is not True or value.get("rollbackAnchor") is not True:
        fail("Online update rollback plan backup anchor is not verified")
    if not isinstance(value.get("fileName"), str) or not value["fileName"].endswith(".mdbak"):
        fail("Online update rollback plan backup file name is invalid")
    if not isinstance(value.get("sha256"), str) or not SHA256_PATTERN.fullmatch(value["sha256"]):
        fail("Online update rollback plan backup SHA-256 is invalid")
    if not isinstance(value.get("createdAt"), str):
        fail("Online update rollback plan backup timestamp is invalid")
    return dict(value)


def validate_record(record: Any) -> dict[str, Any]:
    expected = {
        "rollbackPlanVersion", "phase", "journalSignature", "executionPlanSignature",
        "executionPlanEnvelopeSha256", "manifestFingerprint", "currentVersion", "targetVersion",
        "rollbackStartedEventSignature", "rollbackTriggerEventSignature", "rollbackTriggerPhase",
        "rollbackAnchor", "writerStopIntentSignature", "writerStopIntentFingerprint", "composeProject",
        "preUpdateWriters", "dataRestorePolicy", "writerImageRestorePolicy", "caddyPolicy",
        "restoreCompletionVerificationRequired", "preUpdateImagePresenceRequired",
        "rollbackReceiptRequiredBeforeCompletion", "productionMutationAllowed", "rollbackExecuted",
        "planFingerprint",
    }
    if not isinstance(record, dict) or set(record) != expected:
        fail("Online update rollback-plan fields do not exactly match v1 contract")
    if record.get("rollbackPlanVersion") != 1 or record.get("phase") != "PLANNED":
        fail("Online update rollback-plan version or phase is invalid")
    for field in ("journalSignature", "executionPlanSignature", "rollbackStartedEventSignature", "rollbackTriggerEventSignature", "writerStopIntentSignature"):
        if not isinstance(record.get(field), str) or not HMAC_PATTERN.fullmatch(record[field]):
            fail(f"Online update rollback-plan {field} is invalid")
    for field in ("executionPlanEnvelopeSha256", "manifestFingerprint", "writerStopIntentFingerprint", "planFingerprint"):
        if not isinstance(record.get(field), str) or not SHA256_PATTERN.fullmatch(record[field]):
            fail(f"Online update rollback-plan {field} is invalid")
    if not isinstance(record.get("currentVersion"), str) or not isinstance(record.get("targetVersion"), str):
        fail("Online update rollback-plan versions are invalid")
    if not isinstance(record.get("rollbackTriggerPhase"), str) or record["rollbackTriggerPhase"] in {"ROLLBACK_STARTED", "ROLLBACK_COMPLETED", "COMPLETED"}:
        fail("Online update rollback-plan trigger phase is invalid")
    validate_backup(record.get("rollbackAnchor"))
    if not isinstance(record.get("composeProject"), str) or not record["composeProject"]:
        fail("Online update rollback-plan Compose project is invalid")
    writers = record.get("preUpdateWriters")
    if not isinstance(writers, list) or [item.get("service") if isinstance(item, dict) else None for item in writers] != EXPECTED_WRITERS:
        fail("Online update rollback-plan writer order is invalid")
    for item in writers:
        if set(item) != {"service", "imageId", "configuredImage"}:
            fail("Online update rollback-plan writer image fields are invalid")
        if not isinstance(item["imageId"], str) or not DOCKER_IMAGE_ID.fullmatch(item["imageId"]):
            fail(f"Online update rollback-plan {item['service']} image ID is invalid")
        if not isinstance(item["configuredImage"], str) or not item["configuredImage"]:
            fail(f"Online update rollback-plan {item['service']} configured image is invalid")
    required = {
        "dataRestorePolicy": "RESTORE_VERIFIED_PREUPDATE_BACKUP_VIA_RESTORE_PROMOTION_PIPELINE",
        "writerImageRestorePolicy": "RECREATE_PREUPDATE_WRITERS_FROM_BOUND_IMAGE_IDS_WITH_PULL_DISABLED",
        "caddyPolicy": "PRESERVE_CURRENT",
        "restoreCompletionVerificationRequired": True,
        "preUpdateImagePresenceRequired": True,
        "rollbackReceiptRequiredBeforeCompletion": True,
        "productionMutationAllowed": False,
        "rollbackExecuted": False,
    }
    for field, wanted in required.items():
        if record.get(field) != wanted:
            fail(f"Online update rollback-plan safety field {field} is invalid")
    without_fingerprint = {key: value for key, value in record.items() if key != "planFingerprint"}
    if record["planFingerprint"] != sha256_json(without_fingerprint):
        fail("Online update rollback-plan fingerprint does not match record")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        fail("Online update rollback-plan envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update rollback-plan signature is invalid")
    if not hmac.compare_digest(signature, sign_record(key, record)):
        fail("Online update rollback-plan signature verification failed")
    return {"envelopeVersion": 1, "record": record, "signature": signature}


def create_record(journal: dict[str, Any], events: list[dict[str, Any]], intent: dict[str, Any]) -> dict[str, Any]:
    if not events or events[-1]["record"]["phase"] != "ROLLBACK_STARTED":
        fail("Online update rollback plan requires ROLLBACK_STARTED as latest execution event")
    rollback_started = events[-1]
    previous_signature = rollback_started["record"].get("previousEventSignature")
    if not isinstance(previous_signature, str) or not HMAC_PATTERN.fullmatch(previous_signature):
        fail("ROLLBACK_STARTED lacks a valid rollback-trigger event signature")
    trigger = next((event for event in events[:-1] if event.get("signature") == previous_signature), None)
    if trigger is None:
        fail("ROLLBACK_STARTED trigger event is missing from verified execution chain")

    jrec = journal["record"]
    irec = intent["record"]
    if irec.get("journalSignature") != journal["signature"] or irec.get("targetVersion") != jrec["targetVersion"]:
        fail("Writer-stop intent does not match online update execution journal")
    writers = irec.get("writers")
    if not isinstance(writers, list) or [item.get("service") if isinstance(item, dict) else None for item in writers] != EXPECTED_WRITERS:
        fail("Writer-stop intent does not contain the expected bound pre-update writers")

    body = {
        "rollbackPlanVersion": 1,
        "phase": "PLANNED",
        "journalSignature": journal["signature"],
        "executionPlanSignature": jrec["executionPlanSignature"],
        "executionPlanEnvelopeSha256": jrec["executionPlanEnvelopeSha256"],
        "manifestFingerprint": jrec["manifestFingerprint"],
        "currentVersion": jrec["currentVersion"],
        "targetVersion": jrec["targetVersion"],
        "rollbackStartedEventSignature": rollback_started["signature"],
        "rollbackTriggerEventSignature": trigger["signature"],
        "rollbackTriggerPhase": trigger["record"]["phase"],
        "rollbackAnchor": validate_backup(jrec["rollbackAnchor"]),
        "writerStopIntentSignature": intent["signature"],
        "writerStopIntentFingerprint": irec["intentFingerprint"],
        "composeProject": irec["composeProject"],
        "preUpdateWriters": [
            {"service": item["service"], "imageId": item["imageId"], "configuredImage": item["configuredImage"]}
            for item in writers
        ],
        "dataRestorePolicy": "RESTORE_VERIFIED_PREUPDATE_BACKUP_VIA_RESTORE_PROMOTION_PIPELINE",
        "writerImageRestorePolicy": "RECREATE_PREUPDATE_WRITERS_FROM_BOUND_IMAGE_IDS_WITH_PULL_DISABLED",
        "caddyPolicy": "PRESERVE_CURRENT",
        "restoreCompletionVerificationRequired": True,
        "preUpdateImagePresenceRequired": True,
        "rollbackReceiptRequiredBeforeCompletion": True,
        "productionMutationAllowed": False,
        "rollbackExecuted": False,
    }
    return validate_record({**body, "planFingerprint": sha256_json(body)})


def persist(target_dir: Path, key: bytes, record: dict[str, Any]) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    envelope = {"envelopeVersion": 1, "record": validate_record(record), "signature": sign_record(key, record)}
    serialized = json.dumps(envelope, indent=2, ensure_ascii=False) + "\n"
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Existing online update rollback-plan evidence is unsafe")
        existing = verify_envelope(read_json(path, "Online update rollback plan"), key)
        if existing != envelope:
            fail("Existing online update rollback plan conflicts with current verified rollback evidence")
        return path, False, existing
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
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--event-key", required=True, type=Path)
    parser.add_argument("--writer-stop-intent", required=True, type=Path)
    parser.add_argument("--writer-stop-intent-key", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        journal_module = load_module("persist-online-update-execution-journal.py", "master_diagnostics_online_update_execution_journal")
        event_module = load_module("persist-online-update-execution-event.py", "master_diagnostics_online_update_execution_event")
        intent_module = load_module("persist-online-update-writer-stop-intent.py", "master_diagnostics_online_update_writer_stop_intent")
        journal = journal_module.verify_envelope(read_json(args.journal, "Online update execution journal"), journal_module.read_key(args.journal_key))
        events = event_module.read_events(args.events_dir, read_key(args.event_key), journal)
        intent = intent_module.verify_envelope(read_json(args.writer_stop_intent, "Online update writer-stop intent"), intent_module.read_key(args.writer_stop_intent_key))
        record = create_record(journal, events, intent)
        key = read_key(args.key_file)
        path, created, envelope = persist(args.target_dir, key, record)
    except (OSError, RollbackPlanError, ValueError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1
    print(canonical_json({
        "mode": "CLUB_ONLINE_UPDATE_ROLLBACK_PLAN_V1",
        "status": "ROLLBACK_PLANNED",
        "planPath": str(path),
        "planCreated": created,
        "planReused": not created,
        "planSignature": envelope["signature"],
        "planFingerprint": envelope["record"]["planFingerprint"],
        "rollbackTriggerPhase": envelope["record"]["rollbackTriggerPhase"],
        "rollbackAnchorSha256": envelope["record"]["rollbackAnchor"]["sha256"],
        "preUpdateWriterServices": [item["service"] for item in envelope["record"]["preUpdateWriters"]],
        "productionMutationAllowed": False,
        "rollbackExecuted": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
