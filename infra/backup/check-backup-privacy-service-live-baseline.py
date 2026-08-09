#!/usr/bin/env python3
"""Verify signed service live-baseline v2 and re-attest current Docker state."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
from datetime import datetime
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


def read_key(path: Path) -> bytes:
    raw = common.read_file(path, "SERVICE_LIVE_BASELINE_KEY", private=True)
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("SERVICE_LIVE_BASELINE_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("SERVICE_LIVE_BASELINE_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def validate_timestamp(value: Any) -> None:
    if not isinstance(value, str) or not CANONICAL_UTC.fullmatch(value):
        fail("SERVICE_LIVE_BASELINE_TIMESTAMP_INVALID", "capturedAt must use canonical UTC milliseconds")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_TIMESTAMP_INVALID: capturedAt is invalid") from exc


def sign(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + common.canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def validate_record(record: dict[str, Any], path: Path, cutover: dict[str, Any], cutover_plan: Path) -> dict[str, Any]:
    if record.get("serviceLiveBaselineVersion") != BASELINE_VERSION:
        fail("SERVICE_LIVE_BASELINE_VERSION_INVALID", "baseline version must be 2")
    baseline_id = record.get("baselineId")
    if not isinstance(baseline_id, str) or not BASELINE_ID.fullmatch(baseline_id) or path.name != f"{baseline_id}.json":
        fail("SERVICE_LIVE_BASELINE_ID_INVALID", "baseline ID/path is invalid")
    validate_timestamp(record.get("capturedAt"))
    expected = {
        "cutoverId": cutover["cutoverId"],
        "cutoverPlanVersion": 2,
        "cutoverPlanFingerprint": cutover["cutoverPlanFingerprint"],
        "cutoverPlanFileSha256": common.sha256_bytes(common.read_file(cutover_plan, "SERVICE_CUTOVER_PLAN", private=True)),
        "authorizationSource": "TARGET_HANDOFF_VERIFIED",
        "targetHandoffFingerprint": cutover["targetHandoffFingerprint"],
        "activationId": cutover["activationId"],
        "renderedComposeSha256": cutover["renderedComposeSha256"],
        "expectedPreCutoverBackupState": "DISABLED",
        "expectedPreCutoverNotificationsState": "DISABLED",
        "targetConfigurationAlreadyStaged": True,
    }
    for field, value in expected.items():
        if record.get(field) != value:
            fail("SERVICE_LIVE_BASELINE_CUTOVER_BINDING_MISMATCH", f"baseline {field} differs from verified cutover v2")
    for field in ("allBoundContainersPresent", "runtimeBackupStateDisabled", "runtimeNotificationsStateDisabled", "healthAndRunningStateVerified", "dataVolumeMountsVerified"):
        if record.get(field) is not True:
            fail("SERVICE_LIVE_BASELINE_INVARIANT_INVALID", f"{field} must be true")
    for field in ("cutoverMutationStarted", "serviceCutoverExecuted", "liveRuntimeAttested", "activationExecuted"):
        if record.get(field) is not False:
            fail("SERVICE_LIVE_BASELINE_BOUNDARY_INVALID", f"{field} must remain false")
    live_state = {
        "composeProjectName": record.get("composeProjectName"),
        "containers": record.get("containers"),
        "dataVolumes": record.get("dataVolumes"),
        "caddyVolumes": record.get("caddyVolumes"),
    }
    live_fp = record.get("liveStateFingerprint")
    if not isinstance(live_fp, str) or not common.SHA256.fullmatch(live_fp) or not hmac.compare_digest(live_fp, common.live_state_fingerprint(live_state)):
        fail("SERVICE_LIVE_BASELINE_STATE_FINGERPRINT_MISMATCH", "live-state fingerprint is invalid")
    identity = {"cutoverPlanFingerprint": cutover["cutoverPlanFingerprint"], "liveStateFingerprint": live_fp}
    expected_id = "baseline-" + hashlib.sha256(common.canonical_json(identity).encode("utf-8")).hexdigest()[:32]
    if baseline_id != expected_id:
        fail("SERVICE_LIVE_BASELINE_ID_MISMATCH", "baseline ID does not match state identity")
    fingerprint = record.get("baselineFingerprint")
    if not isinstance(fingerprint, str) or not common.SHA256.fullmatch(fingerprint):
        fail("SERVICE_LIVE_BASELINE_FINGERPRINT_INVALID", "baseline fingerprint is invalid")
    body = dict(record)
    body.pop("baselineFingerprint")
    if not hmac.compare_digest(fingerprint, common.sha256_bytes(common.canonical_json(body).encode("utf-8"))):
        fail("SERVICE_LIVE_BASELINE_FINGERPRINT_MISMATCH", "baseline fingerprint does not match record")
    return live_state


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cutover-plan-checker", required=True, type=Path)
    parser.add_argument("--handoff-checker", required=True, type=Path)
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
    add_args(parser)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--volume-resolver", type=Path, default=root / "infra/backup/resolve-active-club-volumes.py")
    args = parser.parse_args()
    try:
        key = read_key(args.key_file)
        verified = verify_cutover(args)
        cutover = common.read_cutover_record(args.cutover_plan, verified)
        rendered = common.render_compose(args.compose_file, args.env_file, cutover["renderedComposeSha256"])
        raw = common.read_file(args.baseline, "SERVICE_LIVE_BASELINE", private=True)
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("SERVICE_LIVE_BASELINE_INVALID: baseline is not JSON") from exc
        if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
            fail("SERVICE_LIVE_BASELINE_INVALID", "baseline envelope is invalid")
        record = envelope["record"]
        signed_state = validate_record(record, args.baseline, cutover, args.cutover_plan)
        signature = envelope.get("signature")
        if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature) or not hmac.compare_digest(signature, sign(record, key)):
            fail("SERVICE_LIVE_BASELINE_SIGNATURE_MISMATCH", "baseline HMAC is invalid")
        current_state = common.collect_live_state(rendered, args.volume_resolver)
        current_fp = common.live_state_fingerprint(current_state)
        if not hmac.compare_digest(current_fp, record["liveStateFingerprint"]) or current_state != signed_state:
            fail("SERVICE_LIVE_BASELINE_DRIFT", "current Docker state differs from signed pre-cutover baseline")
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE_VERIFICATION",
            "status": "SERVICE_LIVE_BASELINE_VERIFIED",
            "serviceLiveBaselineVersion": BASELINE_VERSION,
            "baselineId": record["baselineId"],
            "baselineFingerprint": record["baselineFingerprint"],
            "liveStateFingerprint": record["liveStateFingerprint"],
            "cutoverId": record["cutoverId"],
            "cutoverPlanFingerprint": record["cutoverPlanFingerprint"],
            "targetHandoffFingerprint": record["targetHandoffFingerprint"],
            "serviceCutoverExecutionAllowed": True,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE_VERIFICATION",
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
