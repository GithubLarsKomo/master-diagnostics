#!/usr/bin/env python3
"""Persist and verify append-only signed online-update execution events."""

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
EVENT_VERSION = 1
SIGNING_DOMAIN = b"masters:club-online-update-execution-event:v1\n"
FILE_PREFIX = "online-update-event-"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

PHASES = (
    "IMAGE_ACQUISITION_STARTED",
    "IMAGES_ACQUIRED",
    "WRITER_STOP_STARTED",
    "WRITERS_STOPPED",
    "MIGRATION_STARTED",
    "MIGRATION_COMPLETED",
    "APPLICATION_START_STARTED",
    "APPLICATION_STARTED",
    "HEALTH_VERIFIED",
    "COMPLETED",
    "ABORTED_BEFORE_PRODUCTION_MUTATION",
    "ROLLBACK_STARTED",
    "ROLLBACK_COMPLETED",
)
TERMINAL = {"COMPLETED", "ABORTED_BEFORE_PRODUCTION_MUTATION", "ROLLBACK_COMPLETED"}
PRODUCTION_START_PHASE = "WRITER_STOP_STARTED"


class EventError(ValueError):
    pass


def fail(message: str) -> None:
    raise EventError(message)


def load_journal_module():
    path = Path(__file__).with_name("persist-online-update-execution-journal.py")
    spec = importlib.util.spec_from_file_location("master_diagnostics_online_update_execution_journal", path)
    if spec is None or spec.loader is None:
        fail("Unable to load online update execution-journal verifier")
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
        raise EventError(f"{label} is not valid JSON") from exc


def read_key(path: Path, label: str = "Online update execution-event key") -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{label} must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise EventError(f"{label} is not valid base64") from exc
    if len(key) != 32:
        fail(f"{label} must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update execution-event target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update execution-event target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update execution-event target must be a non-symlink directory")
    os.chmod(path, 0o700)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def phase_file_name(phase: str) -> str:
    return FILE_PREFIX + phase.lower().replace("_", "-") + ".json"


def legal_next_phases(events: list[dict[str, Any]]) -> list[str]:
    if not events:
        return ["IMAGE_ACQUISITION_STARTED"]
    last = events[-1]["record"]["phase"]
    if last in TERMINAL:
        return []
    transitions = {
        "IMAGE_ACQUISITION_STARTED": ["IMAGES_ACQUIRED", "ABORTED_BEFORE_PRODUCTION_MUTATION"],
        "IMAGES_ACQUIRED": ["WRITER_STOP_STARTED", "ABORTED_BEFORE_PRODUCTION_MUTATION"],
        "WRITER_STOP_STARTED": ["WRITERS_STOPPED", "ROLLBACK_STARTED"],
        "WRITERS_STOPPED": ["MIGRATION_STARTED", "ROLLBACK_STARTED"],
        "MIGRATION_STARTED": ["MIGRATION_COMPLETED", "ROLLBACK_STARTED"],
        "MIGRATION_COMPLETED": ["APPLICATION_START_STARTED", "ROLLBACK_STARTED"],
        "APPLICATION_START_STARTED": ["APPLICATION_STARTED", "ROLLBACK_STARTED"],
        "APPLICATION_STARTED": ["HEALTH_VERIFIED", "ROLLBACK_STARTED"],
        "HEALTH_VERIFIED": ["COMPLETED", "ROLLBACK_STARTED"],
        "ROLLBACK_STARTED": ["ROLLBACK_COMPLETED"],
    }
    return list(transitions.get(last, []))


def cumulative_state(previous: dict[str, Any] | None, phase: str) -> dict[str, bool]:
    prev = previous["record"] if previous else {}
    return {
        "imageAcquisitionStarted": bool(prev.get("imageAcquisitionStarted")) or phase == "IMAGE_ACQUISITION_STARTED",
        "imagesAcquired": bool(prev.get("imagesAcquired")) or phase == "IMAGES_ACQUIRED",
        "productionMutationStarted": bool(prev.get("productionMutationStarted")) or phase == "WRITER_STOP_STARTED",
        "writersStopped": bool(prev.get("writersStopped")) or phase == "WRITERS_STOPPED",
        "migrationStarted": bool(prev.get("migrationStarted")) or phase == "MIGRATION_STARTED",
        "migrationCompleted": bool(prev.get("migrationCompleted")) or phase == "MIGRATION_COMPLETED",
        "applicationStartStarted": bool(prev.get("applicationStartStarted")) or phase == "APPLICATION_START_STARTED",
        "applicationStarted": bool(prev.get("applicationStarted")) or phase == "APPLICATION_STARTED",
        "healthVerified": bool(prev.get("healthVerified")) or phase == "HEALTH_VERIFIED",
        "rollbackStarted": bool(prev.get("rollbackStarted")) or phase == "ROLLBACK_STARTED",
    }


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update execution-event record is invalid")
    expected = {
        "eventVersion", "sequence", "phase", "recordedAt", "journalSignature", "executionPlanSignature",
        "executionPlanEnvelopeSha256", "targetVersion", "previousEventSignature", "targetOutcome",
        "imageAcquisitionStarted", "imagesAcquired", "productionMutationStarted", "writersStopped",
        "migrationStarted", "migrationCompleted", "applicationStartStarted", "applicationStarted",
        "healthVerified", "rollbackStarted", "terminal", "updateExecuted",
    }
    if set(record) != expected:
        fail("Online update execution-event fields do not exactly match v1 contract")
    if record.get("eventVersion") != 1 or not isinstance(record.get("sequence"), int) or record["sequence"] < 1:
        fail("Online update execution-event version or sequence is invalid")
    if record.get("phase") not in PHASES:
        fail("Online update execution-event phase is invalid")
    if not isinstance(record.get("recordedAt"), str) or not TIMESTAMP_PATTERN.fullmatch(record["recordedAt"]):
        fail("Online update execution-event recordedAt must be canonical UTC ISO-8601")
    for field in ("journalSignature", "executionPlanSignature"):
        if not isinstance(record.get(field), str) or not HMAC_PATTERN.fullmatch(record[field]):
            fail(f"Online update execution-event {field} is invalid")
    if not isinstance(record.get("executionPlanEnvelopeSha256"), str) or not SHA256_PATTERN.fullmatch(record["executionPlanEnvelopeSha256"]):
        fail("Online update execution-event execution-plan byte SHA is invalid")
    previous = record.get("previousEventSignature")
    if previous is not None and (not isinstance(previous, str) or not HMAC_PATTERN.fullmatch(previous)):
        fail("Online update execution-event previous signature is invalid")
    if not isinstance(record.get("targetVersion"), str):
        fail("Online update execution-event target version is invalid")
    expected_outcome = "UPDATED" if record["phase"] == "COMPLETED" else "ROLLED_BACK" if record["phase"] == "ROLLBACK_COMPLETED" else "ABORTED" if record["phase"] == "ABORTED_BEFORE_PRODUCTION_MUTATION" else "IN_PROGRESS"
    if record.get("targetOutcome") != expected_outcome:
        fail("Online update execution-event target outcome is invalid")
    for field in (
        "imageAcquisitionStarted", "imagesAcquired", "productionMutationStarted", "writersStopped",
        "migrationStarted", "migrationCompleted", "applicationStartStarted", "applicationStarted",
        "healthVerified", "rollbackStarted", "terminal", "updateExecuted",
    ):
        if not isinstance(record.get(field), bool):
            fail(f"Online update execution-event {field} must be boolean")
    if record["terminal"] != (record["phase"] in TERMINAL):
        fail("Online update execution-event terminal flag is invalid")
    if record["updateExecuted"] != (record["phase"] == "COMPLETED"):
        fail("Online update execution-event updateExecuted flag is invalid")
    if record["phase"] == "ABORTED_BEFORE_PRODUCTION_MUTATION" and record["productionMutationStarted"]:
        fail("Pre-mutation abort cannot claim production mutation")
    if record["phase"] in {"ROLLBACK_STARTED", "ROLLBACK_COMPLETED"} and not record["productionMutationStarted"]:
        fail("Rollback evidence requires prior production mutation")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        fail("Online update execution-event envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update execution-event signature is invalid")
    if not hmac.compare_digest(signature, sign_record(key, record)):
        fail("Online update execution-event signature verification failed")
    return {"envelopeVersion": 1, "record": record, "signature": signature}


def read_events(target_dir: Path, key: bytes, journal: dict[str, Any]) -> list[dict[str, Any]]:
    if not target_dir.is_absolute():
        fail("Online update execution-event directory must be absolute")
    if not target_dir.exists():
        return []
    if target_dir.is_symlink() or not target_dir.is_dir():
        fail("Online update execution-event target must be a non-symlink directory")
    events: list[dict[str, Any]] = []
    for path in target_dir.glob(FILE_PREFIX + "*.json"):
        if path.is_symlink() or not path.is_file():
            fail("Online update execution-event evidence path is unsafe")
        envelope = verify_envelope(read_json(path, "Online update execution event"), key)
        if path.name != phase_file_name(envelope["record"]["phase"]):
            fail("Online update execution-event file name does not match phase")
        events.append(envelope)
    events.sort(key=lambda item: item["record"]["sequence"])
    seen_phases: set[str] = set()
    previous: dict[str, Any] | None = None
    for index, event in enumerate(events, start=1):
        record = event["record"]
        if record["sequence"] != index:
            fail("Online update execution-event sequence must be contiguous")
        if record["phase"] in seen_phases:
            fail("Online update execution-event phase is duplicated")
        seen_phases.add(record["phase"])
        if record["journalSignature"] != journal["signature"]:
            fail("Online update execution-event is not bound to the supplied journal")
        jrec = journal["record"]
        if record["executionPlanSignature"] != jrec["executionPlanSignature"] or record["executionPlanEnvelopeSha256"] != jrec["executionPlanEnvelopeSha256"] or record["targetVersion"] != jrec["targetVersion"]:
            fail("Online update execution-event does not match journal identity")
        expected_previous = previous["signature"] if previous else None
        if record["previousEventSignature"] != expected_previous:
            fail("Online update execution-event signature chain is broken")
        if record["recordedAt"] < jrec["startedAt"] or (previous and record["recordedAt"] < previous["record"]["recordedAt"]):
            fail("Online update execution-event timestamp order is invalid")
        allowed = legal_next_phases(events[: index - 1])
        if record["phase"] not in allowed:
            fail("Online update execution-event transition is invalid")
        expected_state = cumulative_state(previous, record["phase"])
        for field, wanted in expected_state.items():
            if record[field] is not wanted:
                fail(f"Online update execution-event cumulative state {field} is invalid")
        previous = event
    return events


def create_record(journal: dict[str, Any], events: list[dict[str, Any]], phase: str, recorded_at: str) -> dict[str, Any]:
    if phase not in legal_next_phases(events):
        fail(f"Online update execution-event phase {phase} is not allowed after current evidence")
    if not TIMESTAMP_PATTERN.fullmatch(recorded_at):
        fail("Online update execution-event recordedAt must be canonical UTC ISO-8601")
    previous = events[-1] if events else None
    if recorded_at < journal["record"]["startedAt"] or (previous and recorded_at < previous["record"]["recordedAt"]):
        fail("Online update execution-event timestamp order is invalid")
    state = cumulative_state(previous, phase)
    record = {
        "eventVersion": 1,
        "sequence": len(events) + 1,
        "phase": phase,
        "recordedAt": recorded_at,
        "journalSignature": journal["signature"],
        "executionPlanSignature": journal["record"]["executionPlanSignature"],
        "executionPlanEnvelopeSha256": journal["record"]["executionPlanEnvelopeSha256"],
        "targetVersion": journal["record"]["targetVersion"],
        "previousEventSignature": previous["signature"] if previous else None,
        "targetOutcome": "UPDATED" if phase == "COMPLETED" else "ROLLED_BACK" if phase == "ROLLBACK_COMPLETED" else "ABORTED" if phase == "ABORTED_BEFORE_PRODUCTION_MUTATION" else "IN_PROGRESS",
        **state,
        "terminal": phase in TERMINAL,
        "updateExecuted": phase == "COMPLETED",
    }
    return validate_record(record)


def persist_event(target_dir: Path, key: bytes, journal: dict[str, Any], phase: str, recorded_at: str) -> tuple[Path, bool, dict[str, Any], list[dict[str, Any]]]:
    ensure_target_dir(target_dir)
    events = read_events(target_dir, key, journal)
    existing = next((event for event in events if event["record"]["phase"] == phase), None)
    if existing is not None:
        if existing is not events[-1]:
            fail("Requested online update execution-event phase has already been superseded")
        return target_dir / phase_file_name(phase), False, existing, events
    record = create_record(journal, events, phase, recorded_at)
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(key, record)}
    path = target_dir / phase_file_name(phase)
    serialized = (json.dumps(envelope, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        reread = read_events(target_dir, key, journal)
        existing = next((event for event in reread if event["record"]["phase"] == phase), None)
        if existing is None or existing is not reread[-1]:
            fail("Concurrent online update execution-event creation produced conflicting evidence")
        return path, False, existing, reread
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
    return path, True, envelope, events + [envelope]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--phase", required=True, choices=PHASES)
    parser.add_argument("--recorded-at", required=True)
    args = parser.parse_args()
    try:
        journal_module = load_journal_module()
        journal_key = journal_module.read_key(args.journal_key)
        journal = journal_module.verify_envelope(read_json(args.journal, "Online update execution journal"), journal_key)
        event_key = read_key(args.key_file)
        path, created, envelope, events = persist_event(args.target_dir, event_key, journal, args.phase, args.recorded_at)
        next_allowed = legal_next_phases(events)
    except (OSError, EventError, ValueError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1
    print(canonical_json({
        "mode": "CLUB_ONLINE_UPDATE_EXECUTION_EVENT_V1",
        "status": "EVENT_PERSISTED",
        "eventPath": str(path),
        "eventCreated": created,
        "eventReused": not created,
        "sequence": envelope["record"]["sequence"],
        "phase": envelope["record"]["phase"],
        "eventSignature": envelope["signature"],
        "previousEventSignature": envelope["record"]["previousEventSignature"],
        "nextAllowedPhases": next_allowed,
        "productionMutationStarted": envelope["record"]["productionMutationStarted"],
        "migrationStarted": envelope["record"]["migrationStarted"],
        "terminal": envelope["record"]["terminal"],
        "updateExecuted": envelope["record"]["updateExecuted"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
