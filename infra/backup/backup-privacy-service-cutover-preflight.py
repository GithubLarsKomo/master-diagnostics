#!/usr/bin/env python3
"""Prepare or verify signed pre-mutation privacy-check proof for service cutover."""
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

PROOF_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-service-cutover-preflight:v1\n"
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
ALLOWED_PREFLIGHT_FIELDS = {
    "readyForIrreversibleProcessing",
    "backupState",
    "notificationsState",
    "backupPolicyVersion",
    "notificationPolicyVersion",
    "attestationScope",
    "blockers",
}


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
        fail("CUTOVER_PREFLIGHT_TIMESTAMP_INVALID", "recorded-at must use canonical UTC milliseconds")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("CUTOVER_PREFLIGHT_TIMESTAMP_INVALID: invalid timestamp") from exc


def load_execution_core(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("CUTOVER_PREFLIGHT_EXECUTION_CORE_UNSAFE", "execution core must be an absolute regular file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("CUTOVER_PREFLIGHT_EXECUTION_CORE_PERMISSIONS_UNSAFE", "execution core must not be group/world writable")
    spec = importlib.util.spec_from_file_location("backup_privacy_cutover_execution_preflight", path)
    if spec is None or spec.loader is None:
        fail("CUTOVER_PREFLIGHT_EXECUTION_CORE_INVALID", "could not load execution core")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    required = (
        "read_key",
        "verify_plan",
        "verify_baseline",
        "verify_baseline_authorization",
        "verify_journal",
        "read_events",
        "load_live",
        "classify_live",
        "assess_state",
        "read_file",
        "PHASE_FILE",
    )
    if any(not hasattr(module, name) for name in required):
        fail("CUTOVER_PREFLIGHT_EXECUTION_CORE_INVALID", "execution core lacks required evidence primitives")
    return module


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"proofVersion": PROOF_VERSION, "record": record}
    return "hmac-sha256:" + hmac.new(
        key,
        SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def record_fingerprint(record: dict[str, Any]) -> str:
    body = dict(record)
    body.pop("preflightProofFingerprint", None)
    return sha256_bytes(canonical_json(body).encode("utf-8"))


def read_preflight(path: Path, core: Any) -> tuple[bytes, dict[str, Any]]:
    raw = core.read_file(path, "CUTOVER_PREFLIGHT_RESULT", private=True)
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("CUTOVER_PREFLIGHT_RESULT_INVALID: preflight result is not JSON") from exc
    if not isinstance(result, dict):
        fail("CUTOVER_PREFLIGHT_RESULT_INVALID", "preflight result must be an object")
    unknown = set(result) - ALLOWED_PREFLIGHT_FIELDS
    if unknown:
        fail("CUTOVER_PREFLIGHT_RESULT_FIELDS_UNEXPECTED", "preflight result contains unexpected fields")
    if (
        result.get("readyForIrreversibleProcessing") is not True
        or result.get("backupState") != "ENABLED"
        or result.get("backupPolicyVersion") != "1.0.0"
        or result.get("notificationsState") != "DISABLED"
        or result.get("blockers") != []
    ):
        fail("CUTOVER_PREFLIGHT_RESULT_NOT_READY", "privacy-check did not verify the target policy")
    return raw, result


def static_chain(args: argparse.Namespace, core: Any) -> tuple[bytes, dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    key = core.read_key(args.key_file)
    plan_env = core.verify_plan(args.cutover_plan, key)
    plan = plan_env["record"]
    if plan.get("preflightService") != "privacy-check" or plan.get("preflightMustSucceedBeforeMutation") is not True:
        fail("CUTOVER_PREFLIGHT_PLAN_POLICY_INVALID", "cutover plan does not require privacy-check preflight")
    baseline_env = core.verify_baseline(args.baseline, key, args.cutover_plan, plan)
    verification_sha = core.verify_baseline_authorization(args.baseline_verification, baseline_env["record"], plan)
    journal_env = core.verify_journal(
        args.journal,
        key,
        args.cutover_plan,
        args.baseline,
        args.baseline_verification,
        verification_sha,
        plan,
        baseline_env,
    )
    if args.journal.parent.name != plan["cutoverId"]:
        fail("CUTOVER_PREFLIGHT_JOURNAL_PATH_MISMATCH", "journal parent does not match cutover ID")
    events = core.read_events(args.journal.parent, key, journal_env)
    if not events or events[0]["record"].get("phase") != "CUTOVER_STARTED":
        fail("CUTOVER_PREFLIGHT_CUTOVER_STARTED_MISSING", "durable CUTOVER_STARTED evidence is required")
    return key, plan_env, baseline_env, journal_env, events


def started_binding(args: argparse.Namespace, core: Any, events: list[dict[str, Any]]) -> dict[str, Any]:
    started = events[0]
    started_path = args.journal.parent / core.PHASE_FILE["CUTOVER_STARTED"]
    raw = core.read_file(started_path, "CUTOVER_STARTED_EVENT", private=True)
    if started["record"].get("sequence") != 1 or started["record"].get("previousEventSignature") is not None:
        fail("CUTOVER_PREFLIGHT_CUTOVER_STARTED_INVALID", "CUTOVER_STARTED must be the first execution event")
    return {
        "cutoverStartedEventPath": str(started_path),
        "cutoverStartedEventFileSha256": sha256_bytes(raw),
        "cutoverStartedEventSignature": started["signature"],
    }


def require_pre_mutation_live_state(args: argparse.Namespace, core: Any, baseline_env: dict[str, Any], journal_env: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    if len(events) != 1:
        fail("CUTOVER_PREFLIGHT_EVENTS_ALREADY_ADVANCED", "preflight proof must be created before any event after CUTOVER_STARTED")
    live = core.load_live(args)
    live_class, live_reason = core.classify_live(baseline_env["record"], live)
    assessment = core.assess_state(live_class, live_reason, events, journal_env)
    if live_class != "BASELINE" or assessment.get("status") != "READY_TO_RECREATE_TARGET":
        fail("CUTOVER_PREFLIGHT_PRESTATE_INVALID", "preflight proof must be created while the exact baseline runtime is still active")
    return assessment


def build_record(
    args: argparse.Namespace,
    core: Any,
    plan: dict[str, Any],
    baseline: dict[str, Any],
    journal: dict[str, Any],
    events: list[dict[str, Any]],
    preflight_raw: bytes,
    preflight: dict[str, Any],
    recorded_at: str,
) -> dict[str, Any]:
    validate_timestamp(recorded_at)
    binding = started_binding(args, core, events)
    record: dict[str, Any] = {
        "serviceCutoverPreflightProofVersion": PROOF_VERSION,
        "recordedAt": recorded_at,
        "activationId": plan["activationId"],
        "cutoverId": plan["cutoverId"],
        "baselineId": baseline["baselineId"],
        "cutoverPlanFingerprint": plan["cutoverPlanFingerprint"],
        "baselineFingerprint": baseline["baselineFingerprint"],
        "targetHandoffFingerprint": baseline["targetHandoffFingerprint"],
        "journalFingerprint": journal["journalFingerprint"],
        "preLiveFingerprint": baseline["liveStateFingerprint"],
        **binding,
        "preflightResultPath": str(args.preflight_result),
        "preflightResultFileSha256": sha256_bytes(preflight_raw),
        "preflightService": "privacy-check",
        "readyForIrreversibleProcessing": True,
        "backupState": "ENABLED",
        "backupPolicyVersion": "1.0.0",
        "notificationsState": "DISABLED",
        "notificationPolicyVersion": preflight.get("notificationPolicyVersion"),
        "attestationScope": preflight.get("attestationScope"),
        "blockers": [],
        "preflightVerifiedBeforeMutation": True,
        "targetMutationAuthorized": True,
        "serviceMutationObserved": False,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }
    record["preflightProofFingerprint"] = record_fingerprint(record)
    return record


def persist(path: Path, document: dict[str, Any]) -> bool:
    if not path.is_absolute():
        fail("CUTOVER_PREFLIGHT_OUTPUT_NOT_ABSOLUTE", "proof output must be absolute")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or not path.parent.is_dir():
        fail("CUTOVER_PREFLIGHT_OUTPUT_DIR_UNSAFE", "proof output directory is unsafe")
    os.chmod(path.parent, 0o700)
    if stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
        fail("CUTOVER_PREFLIGHT_OUTPUT_DIR_PERMISSIONS_UNSAFE", "proof output directory must be private")
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("CUTOVER_PREFLIGHT_PROOF_CONFLICT: existing proof is not JSON") from exc
        if existing != document:
            fail("CUTOVER_PREFLIGHT_PROOF_CONFLICT", "existing proof differs")
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
    if document.get("mode") != "BACKUP_PRIVACY_SERVICE_CUTOVER_PREFLIGHT_PROOF" or document.get("status") != "VERIFIED":
        fail("CUTOVER_PREFLIGHT_PROOF_INVALID", "proof top-level metadata is invalid")
    if document.get("proofVersion") != PROOF_VERSION or not isinstance(document.get("record"), dict):
        fail("CUTOVER_PREFLIGHT_PROOF_INVALID", "proof envelope is invalid")
    record = document["record"]
    if record.get("serviceCutoverPreflightProofVersion") != PROOF_VERSION:
        fail("CUTOVER_PREFLIGHT_PROOF_VERSION_INVALID", "proof record version is invalid")
    validate_timestamp(record.get("recordedAt") or "")
    fingerprint = record.get("preflightProofFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("CUTOVER_PREFLIGHT_PROOF_FINGERPRINT_INVALID", "proof fingerprint is invalid")
    if not hmac.compare_digest(fingerprint, record_fingerprint(record)):
        fail("CUTOVER_PREFLIGHT_PROOF_FINGERPRINT_MISMATCH", "proof fingerprint does not match")
    signature = document.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("CUTOVER_PREFLIGHT_PROOF_SIGNATURE_INVALID", "proof signature is invalid")
    if not hmac.compare_digest(signature, sign_record(record, key)):
        fail("CUTOVER_PREFLIGHT_PROOF_SIGNATURE_MISMATCH", "proof HMAC does not match")
    for field in ("preflightVerifiedBeforeMutation", "targetMutationAuthorized"):
        if record.get(field) is not True:
            fail("CUTOVER_PREFLIGHT_PROOF_POLICY_INVALID", f"{field} must be true")
    for field in ("serviceMutationObserved", "serviceCutoverExecuted", "liveRuntimeAttested", "activationExecuted"):
        if record.get(field) is not False:
            fail("CUTOVER_PREFLIGHT_PROOF_BOUNDARY_INVALID", f"{field} must remain false")
    return record


def expected_static_record(
    args: argparse.Namespace,
    core: Any,
    plan: dict[str, Any],
    baseline: dict[str, Any],
    journal: dict[str, Any],
    events: list[dict[str, Any]],
    preflight_raw: bytes,
    preflight: dict[str, Any],
    recorded_at: str,
) -> dict[str, Any]:
    return build_record(args, core, plan, baseline, journal, events, preflight_raw, preflight, recorded_at)


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    core = load_execution_core(args.execution_core)
    key, plan_env, baseline_env, journal_env, events = static_chain(args, core)
    require_pre_mutation_live_state(args, core, baseline_env, journal_env, events)
    preflight_raw, preflight = read_preflight(args.preflight_result, core)
    record = build_record(
        args,
        core,
        plan_env["record"],
        baseline_env["record"],
        journal_env["record"],
        events,
        preflight_raw,
        preflight,
        args.recorded_at or canonical_now(),
    )
    document = {
        "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PREFLIGHT_PROOF",
        "status": "VERIFIED",
        "proofVersion": PROOF_VERSION,
        "preflightProofFingerprint": record["preflightProofFingerprint"],
        "record": record,
        "signature": sign_record(record, key),
    }
    created = persist(args.output, document)
    return {
        **document,
        "proofPath": str(args.output),
        "proofCreated": created,
        "proofReused": not created,
        "targetMutationAuthorized": True,
        "serviceMutationObserved": False,
    }


def check(args: argparse.Namespace) -> dict[str, Any]:
    core = load_execution_core(args.execution_core)
    key, plan_env, baseline_env, journal_env, events = static_chain(args, core)
    preflight_raw, preflight = read_preflight(args.preflight_result, core)
    raw = core.read_file(args.proof, "CUTOVER_PREFLIGHT_PROOF", private=True)
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("CUTOVER_PREFLIGHT_PROOF_INVALID: proof is not JSON") from exc
    if not isinstance(document, dict):
        fail("CUTOVER_PREFLIGHT_PROOF_INVALID", "proof root must be an object")
    record = validate_document(document, key)
    expected = expected_static_record(
        args,
        core,
        plan_env["record"],
        baseline_env["record"],
        journal_env["record"],
        events,
        preflight_raw,
        preflight,
        record["recordedAt"],
    )
    # Later execution events are expected on retries; the proof remains bound to
    # the immutable sequence-1 CUTOVER_STARTED event and original preflight bytes.
    if record != expected:
        fail("CUTOVER_PREFLIGHT_PROOF_DRIFT", "signed proof differs from current static evidence chain")
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PREFLIGHT_PROOF_VERIFICATION",
        "status": "VERIFIED",
        "proofVersion": PROOF_VERSION,
        "preflightProofFingerprint": record["preflightProofFingerprint"],
        "proofFileSha256": sha256_bytes(raw),
        "activationId": record["activationId"],
        "cutoverId": record["cutoverId"],
        "baselineId": record["baselineId"],
        "journalFingerprint": record["journalFingerprint"],
        "targetMutationAuthorized": True,
        "preflightVerifiedBeforeMutation": True,
    }


def add_static_args(parser: argparse.ArgumentParser, root: Path) -> None:
    parser.add_argument("--execution-core", type=Path, default=root / "infra/backup/backup-privacy-service-cutover-execution.py")
    parser.add_argument("--cutover-plan", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--baseline-verification", required=True, type=Path)
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--preflight-result", required=True, type=Path)


def add_live_args(parser: argparse.ArgumentParser) -> None:
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
    add_static_args(p_prepare, root)
    add_live_args(p_prepare)
    p_prepare.add_argument("--output", required=True, type=Path)
    p_prepare.add_argument("--recorded-at")
    p_check = sub.add_parser("check")
    add_static_args(p_check, root)
    p_check.add_argument("--proof", required=True, type=Path)
    args = parser.parse_args()
    try:
        if getattr(args, "recorded_at", None) is not None:
            validate_timestamp(args.recorded_at)
        result = prepare(args) if args.command == "prepare" else check(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PREFLIGHT_PROOF",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "targetMutationAuthorized": False,
            "preflightVerifiedBeforeMutation": False,
            "serviceMutationObserved": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())