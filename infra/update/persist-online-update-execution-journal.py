#!/usr/bin/env python3
"""Persist durable signed pre-mutation execution evidence for an online update."""

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
JOURNAL_VERSION = 1
SIGNING_DOMAIN = b"masters:club-online-update-execution-journal:v1\n"
FILE_NAME = "online-update-execution-journal.json"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class JournalError(ValueError):
    pass


def fail(message: str) -> None:
    raise JournalError(message)


def load_plan_module():
    path = Path(__file__).with_name("persist-online-update-execution-plan.py")
    spec = importlib.util.spec_from_file_location("master_diagnostics_online_update_execution_plan", path)
    if spec is None or spec.loader is None:
        fail("Unable to load online update execution-plan verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_json_bytes(path: Path, label: str) -> tuple[Any, bytes]:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    raw = path.read_bytes()
    try:
        return json.loads(raw.decode("utf-8")), raw
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise JournalError(f"{label} is not valid UTF-8 JSON") from exc


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("Online update execution-journal key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise JournalError("Online update execution-journal key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update execution-journal key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update execution-journal target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update execution-journal target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update execution-journal target must be a non-symlink directory")
    os.chmod(path, 0o700)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def validate_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
        fail("Online update execution-journal startedAt must be canonical UTC ISO-8601")
    return value


def create_record(plan: dict[str, Any], plan_bytes: bytes, started_at: str) -> dict[str, Any]:
    validate_timestamp(started_at)
    record = plan["record"]
    if record.get("executionJournalRequiredBeforeMutation") is not True:
        fail("Online update execution plan does not require a pre-mutation journal")
    return validate_record({
        "journalVersion": 1,
        "phase": "PENDING",
        "startedAt": started_at,
        "executionPlanSignature": plan["signature"],
        "executionPlanEnvelopeSha256": "sha256:" + hashlib.sha256(plan_bytes).hexdigest(),
        "manifestFingerprint": record["manifestFingerprint"],
        "currentVersion": record["currentVersion"],
        "targetVersion": record["targetVersion"],
        "images": [dict(item) for item in record["images"]],
        "rollbackAnchor": dict(record["preUpdateBackup"]),
        "executionOrder": list(record["executionOrder"]),
        "nextStep": "ACQUIRE_EXACT_IMAGES",
        "completedSteps": [],
        "mutationState": "NOT_STARTED",
        "executionJournalRequiredBeforeMutation": True,
        "imageAcquisitionStarted": False,
        "productionMutationStarted": False,
        "migrationStarted": False,
        "rollbackStarted": False,
        "completionRecorded": False,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    })


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update execution-journal record is invalid")
    expected = {
        "journalVersion", "phase", "startedAt", "executionPlanSignature", "executionPlanEnvelopeSha256",
        "manifestFingerprint", "currentVersion", "targetVersion", "images", "rollbackAnchor",
        "executionOrder", "nextStep", "completedSteps", "mutationState",
        "executionJournalRequiredBeforeMutation", "imageAcquisitionStarted", "productionMutationStarted",
        "migrationStarted", "rollbackStarted", "completionRecorded", "imagePullAllowed", "migrationAllowed",
        "productionMutationAllowed", "updateExecuted",
    }
    if set(record) != expected:
        fail("Online update execution-journal fields do not exactly match v1 contract")
    if record.get("journalVersion") != 1 or record.get("phase") != "PENDING":
        fail("Online update execution-journal version or phase is invalid")
    validate_timestamp(record.get("startedAt"))
    if not isinstance(record.get("executionPlanSignature"), str) or not HMAC_PATTERN.fullmatch(record["executionPlanSignature"]):
        fail("Online update execution-journal plan signature is invalid")
    for field in ("executionPlanEnvelopeSha256", "manifestFingerprint"):
        if not isinstance(record.get(field), str) or not SHA256_PATTERN.fullmatch(record[field]):
            fail(f"Online update execution-journal {field} is invalid")
    if not isinstance(record.get("currentVersion"), str) or not isinstance(record.get("targetVersion"), str):
        fail("Online update execution-journal versions are invalid")
    images = record.get("images")
    if not isinstance(images, list) or [item.get("role") if isinstance(item, dict) else None for item in images] != ["APP", "MIGRATOR"]:
        fail("Online update execution-journal image roles are invalid")
    for item in images:
        if set(item) != {"role", "reference", "resolvedDigest"}:
            fail("Online update execution-journal image fields are invalid")
        if not isinstance(item["reference"], str) or "@" not in item["reference"]:
            fail("Online update execution-journal image reference is invalid")
        if item["reference"].rsplit("@", 1)[1] != item["resolvedDigest"] or not SHA256_PATTERN.fullmatch(item["resolvedDigest"]):
            fail("Online update execution-journal image digest binding is invalid")
    rollback = record.get("rollbackAnchor")
    if not isinstance(rollback, dict) or set(rollback) != {"fileName", "sha256", "createdAt", "verified", "rollbackAnchor"}:
        fail("Online update execution-journal rollback anchor is invalid")
    if rollback.get("verified") is not True or rollback.get("rollbackAnchor") is not True:
        fail("Online update execution-journal rollback anchor is not verified")
    if not isinstance(rollback.get("sha256"), str) or not SHA256_PATTERN.fullmatch(rollback["sha256"]):
        fail("Online update execution-journal rollback anchor SHA-256 is invalid")
    expected_order = [
        "ACQUIRE_EXACT_IMAGES", "STOP_APPLICATION_WRITERS", "RUN_CONTROLLED_MIGRATIONS",
        "START_APPLICATION", "VERIFY_APPLICATION_HEALTH", "COMPLETE_UPDATE",
    ]
    if record.get("executionOrder") != expected_order or record.get("nextStep") != expected_order[0]:
        fail("Online update execution-journal execution order is invalid")
    if record.get("completedSteps") != [] or record.get("mutationState") != "NOT_STARTED":
        fail("Online update execution-journal must begin before all execution steps")
    required_flags = {
        "executionJournalRequiredBeforeMutation": True,
        "imageAcquisitionStarted": False,
        "productionMutationStarted": False,
        "migrationStarted": False,
        "rollbackStarted": False,
        "completionRecorded": False,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }
    for field, wanted in required_flags.items():
        if record.get(field) is not wanted:
            fail(f"Online update execution-journal safety flag {field} is invalid")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        fail("Online update execution-journal envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update execution-journal signature is invalid")
    if not hmac.compare_digest(signature, sign_record(key, record)):
        fail("Online update execution-journal signature verification failed")
    return {"envelopeVersion": 1, "record": record, "signature": signature}


def persist(target_dir: Path, key: bytes, record: dict[str, Any]) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Online update execution-journal evidence is not a regular non-symlink file")
        existing, _ = read_json_bytes(path, "Online update execution journal")
        verified = verify_envelope(existing, key)
        if verified["record"] != record:
            fail("Existing online update execution journal does not match the requested execution start")
        return path, False, verified
    record = validate_record(record)
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(key, record)}
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
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--plan-key", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--started-at", required=True)
    args = parser.parse_args()
    try:
        plan_module = load_plan_module()
        plan_value, plan_bytes = read_json_bytes(args.plan, "Online update execution plan")
        plan_key = plan_module.read_key(args.plan_key)
        plan = plan_module.verify_envelope(plan_value, plan_key)
        record = create_record(plan, plan_bytes, args.started_at)
        key = read_key(args.key_file)
        path, created, envelope = persist(args.target_dir, key, record)
    except (OSError, JournalError, ValueError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1
    print(canonical_json({
        "mode": "CLUB_ONLINE_UPDATE_EXECUTION_JOURNAL_V1",
        "status": "PENDING_BEFORE_IMAGE_ACQUISITION_AND_MUTATION",
        "journalPath": str(path),
        "journalCreated": created,
        "journalReused": not created,
        "journalSignature": envelope["signature"],
        "executionPlanSignature": envelope["record"]["executionPlanSignature"],
        "targetVersion": envelope["record"]["targetVersion"],
        "nextStep": envelope["record"]["nextStep"],
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
