#!/usr/bin/env python3
"""Persist HMAC-bound writer-stop intent before the first online-update production mutation."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ENVELOPE_VERSION = 1
INTENT_VERSION = 1
FILE_NAME = "online-update-writer-stop-intent.json"
SIGNING_DOMAIN = b"masters:club-online-update-writer-stop-intent:v1\n"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class WriterStopIntentError(ValueError):
    pass


def fail(message: str) -> None:
    raise WriterStopIntentError(message)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_regular_file(path: Path, label: str) -> Path:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    return path


def read_key(path: Path) -> bytes:
    require_regular_file(path, "Online update writer-stop intent key")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise WriterStopIntentError("Online update writer-stop intent key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update writer-stop intent key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update writer-stop intent target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update writer-stop intent target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update writer-stop intent target must be a non-symlink directory")
    os.chmod(path, 0o700)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def binding_from_assessment(assessment: dict[str, Any]) -> dict[str, Any]:
    if assessment.get("mode") != "CLUB_ONLINE_UPDATE_PRE_STOP_ASSESSMENT_V1" or assessment.get("status") != "READY_FOR_WRITER_STOP_EVIDENCE":
        fail("Writer-stop intent requires a successful fresh pre-stop assessment")
    if assessment.get("currentEventPhase") != "IMAGES_ACQUIRED":
        fail("Writer-stop intent requires IMAGES_ACQUIRED evidence")
    if assessment.get("productionMutationStarted") is not False or assessment.get("writerStopStarted") is not False:
        fail("Writer-stop intent requires production mutation to remain unstarted")
    journal_signature = assessment.get("journalSignature")
    event_signature = assessment.get("currentEventSignature")
    if not isinstance(journal_signature, str) or not HMAC_PATTERN.fullmatch(journal_signature):
        fail("Writer-stop intent assessment journal signature is invalid")
    if not isinstance(event_signature, str) or not HMAC_PATTERN.fullmatch(event_signature):
        fail("Writer-stop intent assessment event signature is invalid")
    target_version = assessment.get("targetVersion")
    compose_project = assessment.get("composeProject")
    writer_services = assessment.get("writerServices")
    writers = assessment.get("writers")
    images = assessment.get("targetImages")
    if not isinstance(target_version, str) or not target_version:
        fail("Writer-stop intent target version is invalid")
    if not isinstance(compose_project, str) or not compose_project:
        fail("Writer-stop intent Compose project is invalid")
    if not isinstance(writer_services, list) or not writer_services or not all(isinstance(v, str) and v for v in writer_services):
        fail("Writer-stop intent writer service list is invalid")
    if writer_services != sorted(writer_services) or len(set(writer_services)) != len(writer_services):
        fail("Writer-stop intent writer services must be sorted and unique")
    if not isinstance(writers, list) or [item.get("service") if isinstance(item, dict) else None for item in writers] != writer_services:
        fail("Writer-stop intent writer identities do not match service order")
    bound_writers: list[dict[str, Any]] = []
    for item in writers:
        expected = {"service", "containerId", "imageId", "configuredImage", "startedAt", "running"}
        if not isinstance(item, dict) or set(item) != expected or item.get("running") is not True:
            fail("Writer-stop intent writer identity is invalid")
        if not isinstance(item.get("containerId"), str) or not re.fullmatch(r"[0-9a-f]{12,64}", item["containerId"]):
            fail("Writer-stop intent container identity is invalid")
        if not isinstance(item.get("imageId"), str) or not SHA256_PATTERN.fullmatch(item["imageId"]):
            fail("Writer-stop intent writer image identity is invalid")
        if not isinstance(item.get("configuredImage"), str) or not item["configuredImage"]:
            fail("Writer-stop intent configured writer image is invalid")
        if not isinstance(item.get("startedAt"), str) or not item["startedAt"]:
            fail("Writer-stop intent writer start identity is invalid")
        bound_writers.append({key: item[key] for key in ("service", "containerId", "imageId", "configuredImage", "startedAt")})
    if not isinstance(images, list) or len(images) != 2:
        fail("Writer-stop intent requires exactly two locally verified target images")
    bound_images: list[dict[str, Any]] = []
    for item in images:
        if not isinstance(item, dict) or set(item) != {"reference", "imageId", "repoDigests"}:
            fail("Writer-stop intent target image identity is invalid")
        if not isinstance(item.get("reference"), str) or "@sha256:" not in item["reference"]:
            fail("Writer-stop intent target image reference is invalid")
        if not isinstance(item.get("imageId"), str) or not SHA256_PATTERN.fullmatch(item["imageId"]):
            fail("Writer-stop intent target image ID is invalid")
        if not isinstance(item.get("repoDigests"), list) or item["reference"] not in item["repoDigests"]:
            fail("Writer-stop intent target RepoDigest is not locally verified")
        bound_images.append({"reference": item["reference"], "imageId": item["imageId"]})
    return {
        "journalSignature": journal_signature,
        "imagesAcquiredEventSignature": event_signature,
        "targetVersion": target_version,
        "composeProject": compose_project,
        "targetImages": bound_images,
        "writerServices": list(writer_services),
        "writers": bound_writers,
    }


def create_record(assessment: dict[str, Any], authorized_at: str) -> dict[str, Any]:
    if not TIMESTAMP_PATTERN.fullmatch(authorized_at):
        fail("Writer-stop intent authorizedAt must be canonical UTC ISO-8601")
    binding = binding_from_assessment(assessment)
    body = {
        "writerStopIntentVersion": 1,
        "phase": "PENDING",
        "authorizedAt": authorized_at,
        **binding,
        "writerStopScope": "EXACT_ASSESSED_APPLICATION_WRITERS",
        "writerStopEvidenceRequiredBeforeMutation": True,
        "databaseMustRemainAvailable": True,
        "productionMutationAllowed": False,
        "writerStopStarted": False,
        "writersStopped": False,
        "migrationAllowed": False,
        "updateExecuted": False,
    }
    body["intentFingerprint"] = "sha256:" + hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return validate_record(body)


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update writer-stop intent record is invalid")
    expected = {
        "writerStopIntentVersion", "phase", "authorizedAt", "journalSignature", "imagesAcquiredEventSignature",
        "targetVersion", "composeProject", "targetImages", "writerServices", "writers", "writerStopScope",
        "writerStopEvidenceRequiredBeforeMutation", "databaseMustRemainAvailable", "productionMutationAllowed",
        "writerStopStarted", "writersStopped", "migrationAllowed", "updateExecuted", "intentFingerprint",
    }
    if set(record) != expected or record.get("writerStopIntentVersion") != 1 or record.get("phase") != "PENDING":
        fail("Online update writer-stop intent fields/version/phase are invalid")
    if not isinstance(record.get("authorizedAt"), str) or not TIMESTAMP_PATTERN.fullmatch(record["authorizedAt"]):
        fail("Online update writer-stop intent authorizedAt is invalid")
    for field in ("journalSignature", "imagesAcquiredEventSignature"):
        if not isinstance(record.get(field), str) or not HMAC_PATTERN.fullmatch(record[field]):
            fail(f"Online update writer-stop intent {field} is invalid")
    if not isinstance(record.get("intentFingerprint"), str) or not SHA256_PATTERN.fullmatch(record["intentFingerprint"]):
        fail("Online update writer-stop intent fingerprint is invalid")
    without_fingerprint = {key: value for key, value in record.items() if key != "intentFingerprint"}
    expected_fingerprint = "sha256:" + hashlib.sha256(canonical_json(without_fingerprint).encode("utf-8")).hexdigest()
    if record["intentFingerprint"] != expected_fingerprint:
        fail("Online update writer-stop intent fingerprint does not match content")
    if record.get("writerStopScope") != "EXACT_ASSESSED_APPLICATION_WRITERS":
        fail("Online update writer-stop intent scope is invalid")
    required = {
        "writerStopEvidenceRequiredBeforeMutation": True,
        "databaseMustRemainAvailable": True,
        "productionMutationAllowed": False,
        "writerStopStarted": False,
        "writersStopped": False,
        "migrationAllowed": False,
        "updateExecuted": False,
    }
    for field, wanted in required.items():
        if record.get(field) is not wanted:
            fail(f"Online update writer-stop intent safety flag {field} is invalid")
    # Reuse assessment-shape validation for bound identities.
    binding_from_assessment({
        "mode": "CLUB_ONLINE_UPDATE_PRE_STOP_ASSESSMENT_V1",
        "status": "READY_FOR_WRITER_STOP_EVIDENCE",
        "currentEventPhase": "IMAGES_ACQUIRED",
        "productionMutationStarted": False,
        "writerStopStarted": False,
        "journalSignature": record["journalSignature"],
        "currentEventSignature": record["imagesAcquiredEventSignature"],
        "targetVersion": record["targetVersion"],
        "composeProject": record["composeProject"],
        "targetImages": [dict(item, repoDigests=[item["reference"]]) for item in record["targetImages"]],
        "writerServices": record["writerServices"],
        "writers": [dict(item, running=True) for item in record["writers"]],
    })
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        fail("Online update writer-stop intent envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update writer-stop intent signature is invalid")
    if not hmac.compare_digest(signature, sign_record(key, record)):
        fail("Online update writer-stop intent signature verification failed")
    return {"envelopeVersion": 1, "record": record, "signature": signature}


def same_binding(record: dict[str, Any], assessment: dict[str, Any]) -> bool:
    binding = binding_from_assessment(assessment)
    return all(record.get(field) == binding[field] for field in binding)


def persist(target_dir: Path, key: bytes, assessment: dict[str, Any], authorized_at: str) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Existing online update writer-stop intent path is unsafe")
        try:
            existing_raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise WriterStopIntentError("Existing online update writer-stop intent is invalid JSON") from exc
        existing = verify_envelope(existing_raw, key)
        if not same_binding(existing["record"], assessment):
            fail("Existing online update writer-stop intent does not match fresh pre-stop assessment")
        return path, False, existing
    record = create_record(assessment, authorized_at)
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(key, record)}
    serialized = (json.dumps(envelope, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(serialized)
    except FileExistsError:
        return persist(target_dir, key, assessment, authorized_at)
    return path, True, envelope


def run_fresh_assessment(args: argparse.Namespace) -> dict[str, Any]:
    assessor = Path(__file__).with_name("assess-online-update-pre-stop.py")
    command = [
        sys.executable, str(assessor),
        "--journal", str(args.journal),
        "--journal-key", str(args.journal_key),
        "--events-dir", str(args.events_dir),
        "--event-key", str(args.event_key),
        "--compose-file", str(args.compose_file),
        "--env-file", str(args.env_file),
    ]
    try:
        completed = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise WriterStopIntentError("Fresh online update pre-stop assessment failed" + (f": {detail}" if detail else "")) from exc
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise WriterStopIntentError("Fresh online update pre-stop assessment returned invalid JSON") from exc
    if not isinstance(value, dict):
        fail("Fresh online update pre-stop assessment returned invalid evidence")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--event-key", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--intent-dir", required=True, type=Path)
    parser.add_argument("--intent-key", required=True, type=Path)
    parser.add_argument("--authorized-at")
    args = parser.parse_args()
    try:
        assessment = run_fresh_assessment(args)
        key = read_key(args.intent_key)
        authorized_at = args.authorized_at or canonical_now()
        path, created, envelope = persist(args.intent_dir, key, assessment, authorized_at)
        print(json.dumps({
            "mode": "CLUB_ONLINE_UPDATE_WRITER_STOP_INTENT_V1",
            "status": "WRITER_STOP_INTENT_PERSISTED",
            "intentPath": str(path),
            "intentCreated": created,
            "intentReused": not created,
            "intentSignature": envelope["signature"],
            "intentFingerprint": envelope["record"]["intentFingerprint"],
            "writerServices": envelope["record"]["writerServices"],
            "writerContainerIds": [item["containerId"] for item in envelope["record"]["writers"]],
            "productionMutationAllowed": False,
            "writerStopStarted": False,
            "migrationAllowed": False,
            "updateExecuted": False,
        }, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, WriterStopIntentError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
