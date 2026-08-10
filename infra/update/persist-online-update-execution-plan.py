#!/usr/bin/env python3
"""Persist a signed, non-mutating execution plan for a prepared and registry-resolved online update."""

from __future__ import annotations

import argparse
import base64
import hmac
import importlib.util
import json
import os
import re
from pathlib import Path
from typing import Any

ENVELOPE_VERSION = 1
PLAN_VERSION = 1
SIGNING_DOMAIN = b"masters:club-online-update-execution-plan:v1\n"
FILE_NAME = "online-update-execution-plan.json"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class PlanError(ValueError):
    pass


def fail(message: str) -> None:
    raise PlanError(message)


def load_module(file_name: str, module_name: str):
    path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        fail(f"Unable to load {module_name} module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path, label: str) -> Any:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PlanError(f"{label} is not valid JSON") from exc


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("Online update execution-plan key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise PlanError("Online update execution-plan key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update execution-plan key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update execution-plan target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update execution-plan target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update execution-plan target must be a non-symlink directory")
    os.chmod(path, 0o700)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    import hashlib
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def assert_chain(preparation: dict[str, Any], resolution: dict[str, Any]) -> None:
    prep = preparation["record"]
    resolved = resolution["record"]
    if resolved["preparationSignature"] != preparation["signature"]:
        fail("Image-resolution evidence is not bound to the supplied preparation")
    if resolved["manifestFingerprint"] != prep["manifestFingerprint"]:
        fail("Image-resolution manifest fingerprint does not match preparation")
    if resolved["targetVersion"] != prep["targetVersion"]:
        fail("Image-resolution target version does not match preparation")
    prep_images = [(item["role"], item["reference"]) for item in prep["images"]]
    resolved_images = [(item["role"], item["reference"]) for item in resolved["images"]]
    if prep_images != resolved_images:
        fail("Image-resolution references do not exactly match preparation")
    if not resolved["allImmutableReferencesAvailable"] or not resolved["descriptorDigestsMatch"]:
        fail("Image-resolution evidence is not ready for planning")


def create_record(preparation: dict[str, Any], resolution: dict[str, Any]) -> dict[str, Any]:
    assert_chain(preparation, resolution)
    prep = preparation["record"]
    resolved = resolution["record"]
    return validate_record({
        "planVersion": 1,
        "phase": "PLANNED",
        "preparationSignature": preparation["signature"],
        "imageResolutionSignature": resolution["signature"],
        "manifestFingerprint": prep["manifestFingerprint"],
        "currentVersion": prep["currentVersion"],
        "targetVersion": prep["targetVersion"],
        "images": [
            {
                "role": item["role"],
                "reference": item["reference"],
                "resolvedDigest": item["digest"],
            }
            for item in resolved["images"]
        ],
        "preUpdateBackup": {
            "fileName": prep["preUpdateBackup"]["fileName"],
            "sha256": prep["preUpdateBackup"]["sha256"],
            "createdAt": prep["preUpdateBackup"]["createdAt"],
            "verified": True,
            "rollbackAnchor": True,
        },
        "executionOrder": [
            "ACQUIRE_EXACT_IMAGES",
            "STOP_APPLICATION_WRITERS",
            "RUN_CONTROLLED_MIGRATIONS",
            "START_APPLICATION",
            "VERIFY_APPLICATION_HEALTH",
            "COMPLETE_UPDATE",
        ],
        "migrationPolicy": "CONTROLLED_MIGRATIONS_BEFORE_APP_START",
        "rollbackPolicy": "RESTORE_VERIFIED_PREUPDATE_BACKUP",
        "rollbackTriggerPolicy": "ANY_POST_STOP_FAILURE_BEFORE_COMPLETION",
        "healthPolicy": {
            "appHealthRequired": True,
            "databaseHealthRequired": True,
            "backgroundServicesRequired": True,
            "versionMustEqualTarget": True,
        },
        "executionJournalRequiredBeforeMutation": True,
        "rollbackReceiptRequiredAfterRollback": True,
        "completionReceiptRequiredAfterHealthcheck": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    })


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update execution-plan record is invalid")
    expected = {
        "planVersion", "phase", "preparationSignature", "imageResolutionSignature",
        "manifestFingerprint", "currentVersion", "targetVersion", "images", "preUpdateBackup",
        "executionOrder", "migrationPolicy", "rollbackPolicy", "rollbackTriggerPolicy",
        "healthPolicy", "executionJournalRequiredBeforeMutation", "rollbackReceiptRequiredAfterRollback",
        "completionReceiptRequiredAfterHealthcheck", "imagePullAllowed", "migrationAllowed",
        "productionMutationAllowed", "updateExecuted",
    }
    if set(record) != expected:
        fail("Online update execution-plan fields do not exactly match v1 contract")
    if record.get("planVersion") != 1 or record.get("phase") != "PLANNED":
        fail("Online update execution-plan version or phase is invalid")
    for field in ("preparationSignature", "imageResolutionSignature"):
        if not isinstance(record.get(field), str) or not HMAC_PATTERN.fullmatch(record[field]):
            fail(f"Online update execution-plan {field} is invalid")
    if not isinstance(record.get("manifestFingerprint"), str) or not SHA256_PATTERN.fullmatch(record["manifestFingerprint"]):
        fail("Online update execution-plan manifest fingerprint is invalid")
    if not isinstance(record.get("currentVersion"), str) or not isinstance(record.get("targetVersion"), str):
        fail("Online update execution-plan versions are invalid")
    images = record.get("images")
    if not isinstance(images, list) or [i.get("role") if isinstance(i, dict) else None for i in images] != ["APP", "MIGRATOR"]:
        fail("Online update execution-plan image roles are invalid")
    for item in images:
        if set(item) != {"role", "reference", "resolvedDigest"}:
            fail("Online update execution-plan image fields are invalid")
        if not isinstance(item["reference"], str) or "@" not in item["reference"]:
            fail("Online update execution-plan image reference is invalid")
        digest = item["reference"].rsplit("@", 1)[1]
        if item["resolvedDigest"] != digest or not SHA256_PATTERN.fullmatch(digest):
            fail("Online update execution-plan image digest binding is invalid")
    backup = record.get("preUpdateBackup")
    if not isinstance(backup, dict) or set(backup) != {"fileName", "sha256", "createdAt", "verified", "rollbackAnchor"}:
        fail("Online update execution-plan backup binding is invalid")
    if backup.get("verified") is not True or backup.get("rollbackAnchor") is not True:
        fail("Online update execution-plan backup is not a verified rollback anchor")
    if not isinstance(backup.get("sha256"), str) or not SHA256_PATTERN.fullmatch(backup["sha256"]):
        fail("Online update execution-plan backup SHA-256 is invalid")
    expected_order = [
        "ACQUIRE_EXACT_IMAGES",
        "STOP_APPLICATION_WRITERS",
        "RUN_CONTROLLED_MIGRATIONS",
        "START_APPLICATION",
        "VERIFY_APPLICATION_HEALTH",
        "COMPLETE_UPDATE",
    ]
    if record.get("executionOrder") != expected_order:
        fail("Online update execution-plan order is invalid")
    if record.get("migrationPolicy") != "CONTROLLED_MIGRATIONS_BEFORE_APP_START":
        fail("Online update execution-plan migration policy is invalid")
    if record.get("rollbackPolicy") != "RESTORE_VERIFIED_PREUPDATE_BACKUP":
        fail("Online update execution-plan rollback policy is invalid")
    if record.get("rollbackTriggerPolicy") != "ANY_POST_STOP_FAILURE_BEFORE_COMPLETION":
        fail("Online update execution-plan rollback trigger policy is invalid")
    health = record.get("healthPolicy")
    if health != {
        "appHealthRequired": True,
        "databaseHealthRequired": True,
        "backgroundServicesRequired": True,
        "versionMustEqualTarget": True,
    }:
        fail("Online update execution-plan health policy is invalid")
    required_flags = {
        "executionJournalRequiredBeforeMutation": True,
        "rollbackReceiptRequiredAfterRollback": True,
        "completionReceiptRequiredAfterHealthcheck": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }
    for field, wanted in required_flags.items():
        if record.get(field) is not wanted:
            fail(f"Online update execution-plan safety flag {field} is invalid")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        fail("Online update execution-plan envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update execution-plan signature is invalid")
    if not hmac.compare_digest(signature, sign_record(key, record)):
        fail("Online update execution-plan signature verification failed")
    return {"envelopeVersion": 1, "record": record, "signature": signature}


def persist(target_dir: Path, key: bytes, record: dict[str, Any]) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Online update execution-plan evidence is not a regular non-symlink file")
        existing = verify_envelope(read_json(path, "Online update execution plan"), key)
        if existing["record"] != record:
            fail("Existing online update execution plan does not match current verified inputs")
        return path, False, existing
    record = validate_record(record)
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(key, record)}
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
    parser.add_argument("--preparation", required=True, type=Path)
    parser.add_argument("--preparation-key", required=True, type=Path)
    parser.add_argument("--resolution", required=True, type=Path)
    parser.add_argument("--resolution-key", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        prep_module = load_module("persist-online-update-preparation.py", "master_diagnostics_online_update_preparation")
        resolution_module = load_module("resolve-online-update-images.py", "master_diagnostics_online_update_image_resolution")
        prep_key = prep_module.read_key(args.preparation_key)
        resolution_key = resolution_module.read_key(args.resolution_key)
        preparation = prep_module.verify_envelope(read_json(args.preparation, "Online update preparation"), prep_key)
        resolution = resolution_module.verify_envelope(read_json(args.resolution, "Online update image resolution"), resolution_key)
        record = create_record(preparation, resolution)
        key = read_key(args.key_file)
        path, created, envelope = persist(args.target_dir, key, record)
    except (OSError, PlanError, ValueError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1
    print(canonical_json({
        "mode": "CLUB_ONLINE_UPDATE_EXECUTION_PLAN_V1",
        "status": "PLANNED_AWAITING_EXECUTION_JOURNAL",
        "planPath": str(path),
        "planCreated": created,
        "planReused": not created,
        "planSignature": envelope["signature"],
        "targetVersion": envelope["record"]["targetVersion"],
        "executionOrder": envelope["record"]["executionOrder"],
        "rollbackBackupSha256": envelope["record"]["preUpdateBackup"]["sha256"],
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
