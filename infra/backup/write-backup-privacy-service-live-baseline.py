#!/usr/bin/env python3
"""Persist signed read-only live Docker baseline before backup-privacy service cutover."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import backup_privacy_service_live_baseline_common as common

BASELINE_VERSION = 2
SIGNING_DOMAIN = b"masters:backup-privacy-service-live-baseline:v2\n"
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
BASELINE_ID = re.compile(r"^baseline-[0-9a-f]{32}$")


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_timestamp(value: str) -> None:
    if not CANONICAL_UTC.fullmatch(value):
        fail("SERVICE_LIVE_BASELINE_TIMESTAMP_INVALID", "captured-at must use canonical UTC milliseconds")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_TIMESTAMP_INVALID: captured-at is invalid") from exc


def read_key(path: Path) -> bytes:
    raw = common.read_file(path, "SERVICE_LIVE_BASELINE_KEY", private=True)
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("SERVICE_LIVE_BASELINE_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("SERVICE_LIVE_BASELINE_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def safe_output_root(path: Path) -> None:
    if not path.is_absolute():
        fail("SERVICE_LIVE_BASELINE_OUTPUT_NOT_ABSOLUTE", "output root must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("SERVICE_LIVE_BASELINE_OUTPUT_UNSAFE", "output root must be a non-symlink directory")
    os.chmod(path, 0o700)
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("SERVICE_LIVE_BASELINE_OUTPUT_PERMISSIONS_UNSAFE", "output root must be private")


def expected_signature(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(
        key,
        SIGNING_DOMAIN + common.canonical_json(payload).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def read_existing(path: Path, key: bytes, baseline_id: str, live_fp: str, cutover_fp: str) -> dict[str, Any]:
    raw = common.read_file(path, "SERVICE_LIVE_BASELINE", private=True)
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_CONFLICT: existing baseline is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline envelope is invalid")
    record = envelope["record"]
    if record.get("serviceLiveBaselineVersion") != BASELINE_VERSION or record.get("baselineId") != baseline_id:
        fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline identity is invalid")
    if record.get("liveStateFingerprint") != live_fp or record.get("cutoverPlanFingerprint") != cutover_fp:
        fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline is bound to different state")
    fingerprint = record.get("baselineFingerprint")
    if not isinstance(fingerprint, str) or not common.SHA256.fullmatch(fingerprint):
        fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline fingerprint is invalid")
    body = dict(record)
    body.pop("baselineFingerprint")
    if not hmac.compare_digest(fingerprint, common.sha256_bytes(common.canonical_json(body).encode("utf-8"))):
        fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline fingerprint does not match")
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline signature is invalid")
    if not hmac.compare_digest(signature, expected_signature(record, key)):
        fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline HMAC does not match")
    return envelope


def persist(path: Path, envelope: dict[str, Any]) -> None:
    serialized = (json.dumps(envelope, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def build_record(cutover: dict[str, Any], cutover_plan: Path, live_state: dict[str, Any], captured_at: str) -> dict[str, Any]:
    live_fp = common.live_state_fingerprint(live_state)
    identity = {
        "cutoverPlanFingerprint": cutover["cutoverPlanFingerprint"],
        "liveStateFingerprint": live_fp,
    }
    baseline_id = "baseline-" + hashlib.sha256(common.canonical_json(identity).encode("utf-8")).hexdigest()[:32]
    record: dict[str, Any] = {
        "serviceLiveBaselineVersion": BASELINE_VERSION,
        "baselineId": baseline_id,
        "capturedAt": captured_at,
        "cutoverId": cutover["cutoverId"],
        "cutoverPlanVersion": 2,
        "cutoverPlanFingerprint": cutover["cutoverPlanFingerprint"],
        "cutoverPlanFileSha256": common.sha256_bytes(common.read_file(cutover_plan, "SERVICE_CUTOVER_PLAN", private=True)),
        "targetHandoffFingerprint": cutover["targetHandoffFingerprint"],
        "activationId": cutover["activationId"],
        "renderedComposeSha256": cutover["renderedComposeSha256"],
        "expectedPreCutoverBackupState": "DISABLED",
        "expectedPreCutoverNotificationsState": "DISABLED",
        "targetConfigurationAlreadyStaged": True,
        "composeProjectName": live_state["composeProjectName"],
        "containers": live_state["containers"],
        "dataVolumes": live_state["dataVolumes"],
        "caddyVolumes": live_state["caddyVolumes"],
        "liveStateFingerprint": live_fp,
        "allBoundContainersPresent": True,
        "runtimeBackupStateDisabled": True,
        "runtimeNotificationsStateDisabled": True,
        "healthAndRunningStateVerified": True,
        "dataVolumeMountsVerified": True,
        "cutoverMutationStarted": False,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }
    record["baselineFingerprint"] = common.sha256_bytes(common.canonical_json(record).encode("utf-8"))
    return record


def add_chain_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cutover-plan-checker", required=True, type=Path)
    parser.add_argument("--handoff-checker", required=True, type=Path)
    parser.add_argument("--activation-plan-checker", required=True, type=Path)
    parser.add_argument("--execution-evidence-checker", required=True, type=Path)
    parser.add_argument("--target-config-checker", required=True, type=Path)
    parser.add_argument("--activation-plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--handoff", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--cutover-plan", required=True, type=Path)


def verify_cutover(args: argparse.Namespace) -> dict[str, Any]:
    return common.verify_cutover_plan(
        args.cutover_plan_checker,
        handoff_checker=args.handoff_checker,
        activation_plan_checker=args.activation_plan_checker,
        execution_evidence_checker=args.execution_evidence_checker,
        target_config_checker=args.target_config_checker,
        activation_plan=args.activation_plan,
        pending=args.pending,
        handoff=args.handoff,
        key_file=args.key_file,
        env_file=args.env_file,
        compose_file=args.compose_file,
        cutover_plan=args.cutover_plan,
    )


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    add_chain_args(parser)
    parser.add_argument("--volume-resolver", type=Path, default=root / "infra/backup/resolve-active-club-volumes.py")
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--captured-at")
    args = parser.parse_args()
    try:
        key = read_key(args.key_file)
        captured_at = args.captured_at or canonical_now()
        validate_timestamp(captured_at)
        verified = verify_cutover(args)
        cutover = common.read_cutover_record(args.cutover_plan, verified)
        rendered = common.render_compose(args.compose_file, args.env_file, cutover["renderedComposeSha256"])
        live_state = common.collect_live_state(rendered, args.volume_resolver)
        record = build_record(cutover, args.cutover_plan, live_state, captured_at)
        safe_output_root(args.output_root)
        path = args.output_root / f"{record['baselineId']}.json"
        if path.exists():
            envelope = read_existing(path, key, record["baselineId"], record["liveStateFingerprint"], record["cutoverPlanFingerprint"])
            created = False
            record = envelope["record"]
        else:
            envelope = {"envelopeVersion": 1, "record": record, "signature": expected_signature(record, key)}
            persist(path, envelope)
            created = True
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
            "status": "SERVICE_LIVE_BASELINE_RECORDED",
            "serviceLiveBaselineVersion": BASELINE_VERSION,
            "baselineId": record["baselineId"],
            "cutoverId": record["cutoverId"],
            "baselineFingerprint": record["baselineFingerprint"],
            "liveStateFingerprint": record["liveStateFingerprint"],
            "baselinePath": str(path),
            "baselineCreated": created,
            "baselineReused": not created,
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
            "status": "BLOCKED",
            "blocker": blocker,
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
