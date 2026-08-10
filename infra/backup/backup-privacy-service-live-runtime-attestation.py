#!/usr/bin/env python3
"""Prepare or verify signed live-runtime attestation for backup-privacy cutover."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.util
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ATTESTATION_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-service-live-runtime-attestation:v1\n"
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_timestamp(value: str) -> None:
    if not CANONICAL_UTC.fullmatch(value):
        fail("LIVE_RUNTIME_ATTESTATION_TIMESTAMP_INVALID", "recorded-at must use canonical UTC milliseconds")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("LIVE_RUNTIME_ATTESTATION_TIMESTAMP_INVALID: invalid timestamp") from exc


def load_execution_core(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("LIVE_RUNTIME_ATTESTATION_EXECUTION_CORE_UNSAFE", "execution core must be an absolute regular file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("LIVE_RUNTIME_ATTESTATION_EXECUTION_CORE_PERMISSIONS_UNSAFE", "execution core must not be group/world writable")
    spec = importlib.util.spec_from_file_location("backup_privacy_cutover_execution_attestation", path)
    if spec is None or spec.loader is None:
        fail("LIVE_RUNTIME_ATTESTATION_EXECUTION_CORE_INVALID", "could not load execution core")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    required = (
        "read_key", "verify_plan", "verify_baseline", "verify_baseline_authorization", "verify_journal",
        "load_live", "classify_live", "read_events", "assess_state", "mount_name", "read_file",
    )
    if any(not callable(getattr(module, name, None)) for name in required):
        fail("LIVE_RUNTIME_ATTESTATION_EXECUTION_CORE_INVALID", "execution core lacks required evidence primitives")
    return module


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"attestationVersion": ATTESTATION_VERSION, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def record_fingerprint(record: dict[str, Any]) -> str:
    body = dict(record)
    body.pop("attestationFingerprint", None)
    return sha256_bytes(canonical_json(body).encode("utf-8"))


def evaluate(args: argparse.Namespace, core: Any) -> tuple[bytes, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, dict[str, Any]], dict[str, Any]]:
    key = core.read_key(args.key_file)
    plan_env = core.verify_plan(args.cutover_plan, key)
    baseline_env = core.verify_baseline(args.baseline, key, args.cutover_plan, plan_env["record"])
    verification_sha = core.verify_baseline_authorization(args.baseline_verification, baseline_env["record"], plan_env["record"])
    journal_env = core.verify_journal(
        args.journal,
        key,
        args.cutover_plan,
        args.baseline,
        args.baseline_verification,
        verification_sha,
        plan_env["record"],
        baseline_env,
    )
    if args.journal.parent.name != plan_env["record"]["cutoverId"]:
        fail("LIVE_RUNTIME_ATTESTATION_JOURNAL_PATH_MISMATCH", "journal parent does not match cutover ID")
    live = core.load_live(args)
    live_class, live_reason = core.classify_live(baseline_env["record"], live)
    events = core.read_events(args.journal.parent, key, journal_env)
    assessment = core.assess_state(live_class, live_reason, events, journal_env)
    expected_state = args.state
    if expected_state == "ENABLED":
        if live_class != "TARGET" or assessment.get("status") not in {"READY_TO_VALIDATE_LIVE", "READY_TO_COMPLETE", "COMPLETED"}:
            fail("LIVE_RUNTIME_ATTESTATION_TARGET_NOT_VERIFIED", f"target live state is not attestable: {assessment.get('status')}")
    else:
        if live_class not in {"BASELINE", "ROLLBACK"} or assessment.get("status") not in {"READY_TO_VERIFY_ROLLBACK", "ROLLED_BACK"}:
            fail("LIVE_RUNTIME_ATTESTATION_ROLLBACK_NOT_VERIFIED", f"rollback live state is not attestable: {assessment.get('status')}")
    return key, plan_env, baseline_env, journal_env, live, assessment


def bounded_live_state(core: Any, baseline: dict[str, Any], live: dict[str, dict[str, Any]]) -> dict[str, Any]:
    services: list[dict[str, Any]] = []
    for name in core.ALL_SERVICES:
        item = live[name]
        value: dict[str, Any] = {
            "service": name,
            "containerId": item.get("containerId"),
            "imageId": item.get("imageId"),
            "imageReference": item.get("imageReference"),
            "status": item.get("status"),
            "healthStatus": item.get("healthStatus"),
        }
        if name in core.MUTABLE:
            value["privacyEnvironment"] = item.get("privacyEnvironment")
        services.append(value)
    data_volumes = {
        role: core.mount_name(live[service], destination)
        for role, (service, destination) in core.DATA_VOLUME_DESTINATIONS.items()
    }
    caddy_volumes = {
        role: core.mount_name(live["caddy"], destination)
        for role, destination in core.CADDY_VOLUME_DESTINATIONS.items()
    }
    if data_volumes != baseline["dataVolumes"]:
        fail("LIVE_RUNTIME_ATTESTATION_DATA_VOLUME_DRIFT", "active data volumes differ from signed baseline")
    if caddy_volumes != baseline["caddyVolumes"]:
        fail("LIVE_RUNTIME_ATTESTATION_CADDY_VOLUME_DRIFT", "active Caddy volumes differ from signed baseline")
    return {
        "composeProjectName": baseline["composeProjectName"],
        "services": services,
        "dataVolumes": data_volumes,
        "caddyVolumes": caddy_volumes,
    }


def build_record(args: argparse.Namespace, core: Any, plan: dict[str, Any], baseline: dict[str, Any], journal: dict[str, Any], live: dict[str, dict[str, Any]], assessment: dict[str, Any]) -> dict[str, Any]:
    recorded_at = args.recorded_at or canonical_now()
    validate_timestamp(recorded_at)
    bounded = bounded_live_state(core, baseline, live)
    record: dict[str, Any] = {
        "liveRuntimeAttestationVersion": ATTESTATION_VERSION,
        "recordedAt": recorded_at,
        "backupState": args.state,
        "status": "VERIFIED",
        "activationId": plan["activationId"],
        "cutoverId": plan["cutoverId"],
        "baselineId": baseline["baselineId"],
        "cutoverPlanFingerprint": plan["cutoverPlanFingerprint"],
        "baselineFingerprint": baseline["baselineFingerprint"],
        "targetHandoffFingerprint": baseline["targetHandoffFingerprint"],
        "journalFingerprint": journal["journalFingerprint"],
        "executionAssessmentStatus": assessment["status"],
        "executionEventCount": assessment["eventCount"],
        "executionLastPhase": assessment["lastPhase"],
        "liveState": assessment["liveState"],
        "liveRuntimeAttested": True,
        "serviceCutoverExecuted": assessment["status"] == "COMPLETED",
        "activationExecuted": assessment["status"] == "COMPLETED",
        "boundedLiveState": bounded,
        "boundedLiveStateFingerprint": sha256_bytes(canonical_json(bounded).encode("utf-8")),
    }
    record["attestationFingerprint"] = record_fingerprint(record)
    return record


def persist(path: Path, document: dict[str, Any]) -> bool:
    if not path.is_absolute():
        fail("LIVE_RUNTIME_ATTESTATION_OUTPUT_NOT_ABSOLUTE", "output must be absolute")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or not path.parent.is_dir():
        fail("LIVE_RUNTIME_ATTESTATION_OUTPUT_DIR_UNSAFE", "output directory is unsafe")
    os.chmod(path.parent, 0o700)
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing != document:
            fail("LIVE_RUNTIME_ATTESTATION_CONFLICT", "existing attestation differs")
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    return True


def validate_document(document: dict[str, Any], key: bytes) -> dict[str, Any]:
    if document.get("status") != "VERIFIED" or document.get("backupState") not in {"ENABLED", "DISABLED"}:
        fail("LIVE_RUNTIME_ATTESTATION_DOCUMENT_INVALID", "top-level status/state is invalid")
    if document.get("attestationVersion") != ATTESTATION_VERSION or not isinstance(document.get("record"), dict):
        fail("LIVE_RUNTIME_ATTESTATION_DOCUMENT_INVALID", "attestation document is invalid")
    record = document["record"]
    if record.get("liveRuntimeAttestationVersion") != ATTESTATION_VERSION or record.get("status") != "VERIFIED" or record.get("backupState") != document["backupState"]:
        fail("LIVE_RUNTIME_ATTESTATION_RECORD_INVALID", "attestation record state is invalid")
    validate_timestamp(record.get("recordedAt") or "")
    fingerprint = record.get("attestationFingerprint")
    if not isinstance(fingerprint, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", fingerprint):
        fail("LIVE_RUNTIME_ATTESTATION_FINGERPRINT_INVALID", "attestation fingerprint is invalid")
    if not hmac.compare_digest(fingerprint, record_fingerprint(record)):
        fail("LIVE_RUNTIME_ATTESTATION_FINGERPRINT_MISMATCH", "attestation fingerprint does not match")
    signature = document.get("signature")
    if not isinstance(signature, str) or not re.fullmatch(r"hmac-sha256:[0-9a-f]{64}", signature):
        fail("LIVE_RUNTIME_ATTESTATION_SIGNATURE_INVALID", "attestation signature is invalid")
    if not hmac.compare_digest(signature, sign_record(record, key)):
        fail("LIVE_RUNTIME_ATTESTATION_SIGNATURE_MISMATCH", "attestation HMAC does not match")
    return record


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    core = load_execution_core(args.execution_core)
    key, plan_env, baseline_env, journal_env, live, assessment = evaluate(args, core)
    record = build_record(args, core, plan_env["record"], baseline_env["record"], journal_env["record"], live, assessment)
    document = {
        "mode": "BACKUP_PRIVACY_SERVICE_LIVE_RUNTIME_ATTESTATION",
        "status": "VERIFIED",
        "backupState": args.state,
        "attestationVersion": ATTESTATION_VERSION,
        "attestationFingerprint": record["attestationFingerprint"],
        "record": record,
        "signature": sign_record(record, key),
    }
    created = persist(args.output, document)
    return {**document, "attestationPath": str(args.output), "attestationCreated": created, "attestationReused": not created}


def check(args: argparse.Namespace) -> dict[str, Any]:
    core = load_execution_core(args.execution_core)
    key, plan_env, baseline_env, journal_env, live, assessment = evaluate(args, core)
    raw = core.read_file(args.attestation, "LIVE_RUNTIME_ATTESTATION", private=True)
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("LIVE_RUNTIME_ATTESTATION_DOCUMENT_INVALID: attestation is not JSON") from exc
    if not isinstance(document, dict):
        fail("LIVE_RUNTIME_ATTESTATION_DOCUMENT_INVALID", "attestation root must be an object")
    record = validate_document(document, key)
    expected = build_record(args, core, plan_env["record"], baseline_env["record"], journal_env["record"], live, assessment)
    # recordedAt is immutable observation metadata; all state-bearing fields must re-attest.
    expected["recordedAt"] = record["recordedAt"]
    expected["attestationFingerprint"] = record_fingerprint(expected)
    if record != expected:
        fail("LIVE_RUNTIME_ATTESTATION_DRIFT", "current bounded runtime evidence differs from signed attestation")
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_LIVE_RUNTIME_ATTESTATION_VERIFICATION",
        "status": "VERIFIED",
        "backupState": record["backupState"],
        "attestationVersion": ATTESTATION_VERSION,
        "attestationFingerprint": record["attestationFingerprint"],
        "attestationFileSha256": sha256_bytes(raw),
        "cutoverId": record["cutoverId"],
        "baselineId": record["baselineId"],
        "journalFingerprint": record["journalFingerprint"],
        "liveRuntimeAttested": True,
        "serviceCutoverExecuted": record["serviceCutoverExecuted"],
        "activationExecuted": record["activationExecuted"],
    }


def add_common(parser: argparse.ArgumentParser, root: Path) -> None:
    parser.add_argument("--execution-core", type=Path, default=root / "infra/backup/backup-privacy-service-cutover-execution.py")
    parser.add_argument("--cutover-plan", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--baseline-verification", required=True, type=Path)
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--state", required=True, choices=("ENABLED", "DISABLED"))
    parser.add_argument("--app-inspect", required=True, type=Path)
    parser.add_argument("--export-inspect", required=True, type=Path)
    parser.add_argument("--retention-inspect", required=True, type=Path)
    parser.add_argument("--libsql-inspect", required=True, type=Path)
    parser.add_argument("--caddy-inspect", required=True, type=Path)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p_prepare = sub.add_parser("prepare")
    add_common(p_prepare, root)
    p_prepare.add_argument("--output", required=True, type=Path)
    p_prepare.add_argument("--recorded-at")
    p_check = sub.add_parser("check")
    add_common(p_check, root)
    p_check.add_argument("--attestation", required=True, type=Path)
    args = parser.parse_args()
    try:
        if getattr(args, "recorded_at", None) is not None:
            validate_timestamp(args.recorded_at)
        result = prepare(args) if args.command == "prepare" else check(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_RUNTIME_ATTESTATION",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "liveRuntimeAttested": False,
            "serviceCutoverExecuted": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())