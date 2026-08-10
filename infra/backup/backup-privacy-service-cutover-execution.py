#!/usr/bin/env python3
"""Signed backup-privacy service-cutover journal and crash/retry state assessment.

This module is evidence-only. It never invokes Docker or mutates the target .env.
The later host executor may mutate services only when this state machine says so.
"""
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

JOURNAL_VERSION = 2
EVENT_VERSION = 2
JOURNAL_DOMAIN = b"masters:backup-privacy-service-cutover-execution-journal:v2\n"
EVENT_DOMAIN = b"masters:backup-privacy-service-cutover-execution-event:v2\n"
PLAN_DOMAIN = b"masters:backup-privacy-service-cutover-plan:v2\n"
BASELINE_DOMAIN = b"masters:backup-privacy-service-live-baseline:v2\n"
JOURNAL_FILE = "service-cutover-execution-pending.json"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CUTOVER_ID = re.compile(r"^cutover-[0-9a-f]{32}$")
BASELINE_ID = re.compile(r"^baseline-[0-9a-f]{32}$")
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

MUTABLE = ("app", "export-cleanup", "retention-scan")
PRESERVED = ("libsql", "caddy")
ALL_SERVICES = (*MUTABLE, *PRESERVED)
TARGET = {
    "PRIVACY_BACKUP_STATE": "ENABLED",
    "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
}
TARGET_ONLY = tuple(key for key in TARGET if key != "PRIVACY_BACKUP_STATE")
DATA_VOLUME_DESTINATIONS = {
    "libsql": ("libsql", "/var/lib/sqld"),
    "reports": ("app", "/var/lib/masters/reports"),
    "tenantExports": ("app", "/var/lib/masters/exports"),
    "dataSubjectDelivery": ("app", "/var/lib/masters/data-subject-delivery-packages"),
}
CADDY_VOLUME_DESTINATIONS = {"data": "/data", "config": "/config"}

PHASES = (
    "CUTOVER_STARTED",
    "TARGET_RECREATED",
    "LIVE_VALIDATED",
    "COMPLETED",
    "ROLLBACK_STARTED",
    "ROLLBACK_RECREATED",
    "ROLLBACK_VERIFIED",
)
PHASE_FILE = {
    "CUTOVER_STARTED": "service-cutover-started.json",
    "TARGET_RECREATED": "service-cutover-target-recreated.json",
    "LIVE_VALIDATED": "service-cutover-live-validated.json",
    "COMPLETED": "service-cutover-completed.json",
    "ROLLBACK_STARTED": "service-cutover-rollback-started.json",
    "ROLLBACK_RECREATED": "service-cutover-rollback-recreated.json",
    "ROLLBACK_VERIFIED": "service-cutover-rollback-verified.json",
}
TRANSITIONS: dict[str | None, tuple[str, ...]] = {
    None: ("CUTOVER_STARTED",),
    "CUTOVER_STARTED": ("TARGET_RECREATED", "ROLLBACK_STARTED"),
    "TARGET_RECREATED": ("LIVE_VALIDATED", "ROLLBACK_STARTED"),
    "LIVE_VALIDATED": ("COMPLETED", "ROLLBACK_STARTED"),
    "COMPLETED": (),
    "ROLLBACK_STARTED": ("ROLLBACK_RECREATED",),
    "ROLLBACK_RECREATED": ("ROLLBACK_VERIFIED",),
    "ROLLBACK_VERIFIED": (),
}
TERMINAL = {"COMPLETED", "ROLLBACK_VERIFIED"}
ATTESTATION_PHASES = {"LIVE_VALIDATED", "ROLLBACK_VERIFIED"}


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
        fail("SERVICE_CUTOVER_EXECUTION_TIMESTAMP_INVALID", "timestamp must use canonical UTC milliseconds")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("SERVICE_CUTOVER_EXECUTION_TIMESTAMP_INVALID: invalid timestamp") from exc


def read_file(path: Path, code: str, private: bool = False) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{code}_UNSAFE", "file must be an absolute regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o022:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must not be group/world writable")
    if private and mode & 0o077:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must be private")
    return path.read_bytes()


def read_key(path: Path) -> bytes:
    raw = read_file(path, "SERVICE_CUTOVER_EXECUTION_KEY", private=True)
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("SERVICE_CUTOVER_EXECUTION_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("SERVICE_CUTOVER_EXECUTION_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def read_json(path: Path, code: str, private: bool = False) -> dict[str, Any]:
    raw = read_file(path, code, private=private)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{code}_INVALID: file is not JSON") from exc
    if not isinstance(value, dict):
        fail(f"{code}_INVALID", "JSON root must be an object")
    return value


def read_envelope(path: Path, code: str) -> dict[str, Any]:
    value = read_json(path, code, private=True)
    if value.get("envelopeVersion") != 1 or not isinstance(value.get("record"), dict):
        fail(f"{code}_INVALID", "envelope is invalid")
    return value


def expected_signature(domain: bytes, record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, domain + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def verify_signed_envelope(path: Path, code: str, domain: bytes, key: bytes) -> dict[str, Any]:
    envelope = read_envelope(path, code)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail(f"{code}_SIGNATURE_INVALID", "signature is invalid")
    if not hmac.compare_digest(signature, expected_signature(domain, envelope["record"], key)):
        fail(f"{code}_SIGNATURE_MISMATCH", "HMAC does not match")
    return envelope


def record_fingerprint(record: dict[str, Any], field: str) -> str:
    body = dict(record)
    body.pop(field, None)
    return sha256_bytes(canonical_json(body).encode("utf-8"))


def verify_plan(path: Path, key: bytes) -> dict[str, Any]:
    envelope = verify_signed_envelope(path, "SERVICE_CUTOVER_PLAN", PLAN_DOMAIN, key)
    record = envelope["record"]
    if record.get("serviceCutoverPlanVersion") != 2:
        fail("SERVICE_CUTOVER_PLAN_VERSION_INVALID", "cutover plan must be version 2")
    cutover_id = record.get("cutoverId")
    fingerprint = record.get("cutoverPlanFingerprint")
    if not isinstance(cutover_id, str) or not CUTOVER_ID.fullmatch(cutover_id):
        fail("SERVICE_CUTOVER_ID_INVALID", "cutover ID is invalid")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("SERVICE_CUTOVER_PLAN_FINGERPRINT_INVALID", "cutover plan fingerprint is invalid")
    if not hmac.compare_digest(fingerprint, record_fingerprint(record, "cutoverPlanFingerprint")):
        fail("SERVICE_CUTOVER_PLAN_FINGERPRINT_MISMATCH", "cutover plan fingerprint does not match")
    if record.get("authorizationSource") != "TARGET_HANDOFF_VERIFIED":
        fail("SERVICE_CUTOVER_PLAN_AUTHORIZATION_INVALID", "cutover plan is not target-handoff authorized")
    if record.get("liveBaselineRequiredBeforeMutation") is not True:
        fail("SERVICE_CUTOVER_PLAN_POLICY_INVALID", "cutover plan does not require a live baseline")
    if record.get("recreateServices") != list(MUTABLE) or record.get("preserveServices") != list(PRESERVED):
        fail("SERVICE_CUTOVER_PLAN_SERVICE_POLICY_INVALID", "cutover plan service policy is invalid")
    if record.get("requiredPrivacyEnvironment") != TARGET:
        fail("SERVICE_CUTOVER_PLAN_TARGET_INVALID", "cutover plan target environment is invalid")
    if any(record.get(field) is not False for field in ("serviceCutoverExecuted", "liveRuntimeAttested", "activationExecuted")):
        fail("SERVICE_CUTOVER_PLAN_BOUNDARY_INVALID", "cutover plan must remain nonterminal")
    return envelope


def baseline_live_state(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "composeProjectName": record.get("composeProjectName"),
        "containers": record.get("containers"),
        "dataVolumes": record.get("dataVolumes"),
        "caddyVolumes": record.get("caddyVolumes"),
    }


def verify_baseline(path: Path, key: bytes, plan_path: Path, plan: dict[str, Any]) -> dict[str, Any]:
    envelope = verify_signed_envelope(path, "SERVICE_LIVE_BASELINE", BASELINE_DOMAIN, key)
    record = envelope["record"]
    if record.get("serviceLiveBaselineVersion") != 2:
        fail("SERVICE_LIVE_BASELINE_VERSION_INVALID", "baseline must be version 2")
    baseline_id = record.get("baselineId")
    if not isinstance(baseline_id, str) or not BASELINE_ID.fullmatch(baseline_id):
        fail("SERVICE_LIVE_BASELINE_ID_INVALID", "baseline ID is invalid")
    expected = {
        "cutoverId": plan["cutoverId"],
        "cutoverPlanVersion": 2,
        "cutoverPlanFingerprint": plan["cutoverPlanFingerprint"],
        "cutoverPlanFileSha256": sha256_bytes(read_file(plan_path, "SERVICE_CUTOVER_PLAN", private=True)),
        "authorizationSource": "TARGET_HANDOFF_VERIFIED",
        "targetHandoffFingerprint": plan["targetHandoffFingerprint"],
        "activationId": plan["activationId"],
        "renderedComposeSha256": plan["renderedComposeSha256"],
        "expectedPreCutoverBackupState": "DISABLED",
        "expectedPreCutoverNotificationsState": "DISABLED",
        "targetConfigurationAlreadyStaged": True,
    }
    for field, value in expected.items():
        if record.get(field) != value:
            fail("SERVICE_LIVE_BASELINE_PLAN_BINDING_MISMATCH", f"baseline field {field} differs from cutover plan")
    for field in (
        "allBoundContainersPresent",
        "runtimeBackupStateDisabled",
        "runtimeNotificationsStateDisabled",
        "healthAndRunningStateVerified",
        "dataVolumeMountsVerified",
    ):
        if record.get(field) is not True:
            fail("SERVICE_LIVE_BASELINE_POLICY_INVALID", f"baseline field {field} must be true")
    if any(record.get(field) is not False for field in ("cutoverMutationStarted", "serviceCutoverExecuted", "liveRuntimeAttested", "activationExecuted")):
        fail("SERVICE_LIVE_BASELINE_BOUNDARY_INVALID", "baseline must remain pre-mutation")
    containers = record.get("containers")
    if not isinstance(containers, list) or sorted(item.get("service") for item in containers if isinstance(item, dict)) != sorted(ALL_SERVICES):
        fail("SERVICE_LIVE_BASELINE_CONTAINERS_INVALID", "baseline must bind exactly five services")
    container_map = {item["service"]: item for item in containers}
    for service in MUTABLE:
        env = container_map[service].get("privacyEnvironment")
        if not isinstance(env, dict) or env.get("PRIVACY_BACKUP_STATE") != "DISABLED" or env.get("PRIVACY_NOTIFICATIONS_STATE") != "DISABLED":
            fail("SERVICE_LIVE_BASELINE_MUTABLE_NOT_DISABLED", f"baseline {service} is not DISABLED")
    data_volumes = record.get("dataVolumes")
    if not isinstance(data_volumes, dict) or set(data_volumes) != set(DATA_VOLUME_DESTINATIONS):
        fail("SERVICE_LIVE_BASELINE_VOLUMES_INVALID", "baseline data-volume roles are invalid")
    caddy_volumes = record.get("caddyVolumes")
    if not isinstance(caddy_volumes, dict) or set(caddy_volumes) != set(CADDY_VOLUME_DESTINATIONS):
        fail("SERVICE_LIVE_BASELINE_CADDY_VOLUMES_INVALID", "baseline caddy-volume roles are invalid")
    live_fp = record.get("liveStateFingerprint")
    if not isinstance(live_fp, str) or not SHA256.fullmatch(live_fp):
        fail("SERVICE_LIVE_BASELINE_STATE_FINGERPRINT_INVALID", "live-state fingerprint is invalid")
    if not hmac.compare_digest(live_fp, sha256_bytes(canonical_json(baseline_live_state(record)).encode("utf-8"))):
        fail("SERVICE_LIVE_BASELINE_STATE_FINGERPRINT_MISMATCH", "baseline live-state fingerprint does not match")
    fingerprint = record.get("baselineFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("SERVICE_LIVE_BASELINE_FINGERPRINT_INVALID", "baseline fingerprint is invalid")
    if not hmac.compare_digest(fingerprint, record_fingerprint(record, "baselineFingerprint")):
        fail("SERVICE_LIVE_BASELINE_FINGERPRINT_MISMATCH", "baseline fingerprint does not match")
    return envelope


def verify_baseline_authorization(path: Path, baseline: dict[str, Any], plan: dict[str, Any]) -> str:
    raw = read_file(path, "SERVICE_LIVE_BASELINE_VERIFICATION", private=True)
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_VERIFICATION_INVALID: verifier output is not JSON") from exc
    if not isinstance(result, dict):
        fail("SERVICE_LIVE_BASELINE_VERIFICATION_INVALID", "verifier output must be an object")
    expected = {
        "status": "SERVICE_LIVE_BASELINE_VERIFIED",
        "serviceLiveBaselineVersion": 2,
        "baselineId": baseline["baselineId"],
        "baselineFingerprint": baseline["baselineFingerprint"],
        "liveStateFingerprint": baseline["liveStateFingerprint"],
        "cutoverId": plan["cutoverId"],
        "cutoverPlanFingerprint": plan["cutoverPlanFingerprint"],
        "targetHandoffFingerprint": baseline["targetHandoffFingerprint"],
        "serviceCutoverExecutionAllowed": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }
    for field, value in expected.items():
        if result.get(field) != value:
            fail("SERVICE_LIVE_BASELINE_VERIFICATION_MISMATCH", f"verifier field {field} differs")
    return sha256_bytes(raw)


def service_state(item: dict[str, Any]) -> str:
    env = item.get("privacyEnvironment")
    if not isinstance(env, dict):
        return "UNKNOWN"
    if env.get("PRIVACY_BACKUP_STATE") == "DISABLED" and all(key not in env for key in TARGET_ONLY):
        return "DISABLED"
    if all(env.get(key) == value for key, value in TARGET.items()):
        return "ENABLED"
    return "UNKNOWN"


def read_inspect(path: Path, expected_service: str) -> dict[str, Any]:
    raw = read_file(path, "SERVICE_CUTOVER_EXECUTION_INSPECT")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"SERVICE_CUTOVER_EXECUTION_INSPECT_INVALID: invalid inspect JSON for {expected_service}") from exc
    if not isinstance(parsed, list) or len(parsed) != 1 or not isinstance(parsed[0], dict):
        fail("SERVICE_CUTOVER_EXECUTION_INSPECT_INVALID", f"inspect for {expected_service} must contain exactly one container")
    container = parsed[0]
    config = container.get("Config")
    state = container.get("State")
    mounts = container.get("Mounts")
    if not isinstance(config, dict) or not isinstance(state, dict) or not isinstance(mounts, list):
        fail("SERVICE_CUTOVER_EXECUTION_INSPECT_INVALID", f"inspect fields for {expected_service} are invalid")
    labels = config.get("Labels")
    if not isinstance(labels, dict) or labels.get("com.docker.compose.service") != expected_service:
        fail("SERVICE_CUTOVER_EXECUTION_SERVICE_IDENTITY_INVALID", f"container is not service {expected_service}")
    env: dict[str, str] = {}
    for raw_env in config.get("Env") or []:
        if isinstance(raw_env, str) and "=" in raw_env:
            key, value = raw_env.split("=", 1)
            if key.startswith("PRIVACY_BACKUP_"):
                env[key] = value
    health = state.get("Health")
    return {
        "service": expected_service,
        "containerId": container.get("Id"),
        "imageId": container.get("Image"),
        "imageReference": config.get("Image"),
        "project": labels.get("com.docker.compose.project"),
        "status": state.get("Status"),
        "healthStatus": health.get("Status") if isinstance(health, dict) else None,
        "privacyEnvironment": env,
        "mounts": mounts,
    }


def mount_name(item: dict[str, Any], destination: str) -> str | None:
    matches = [
        mount for mount in item["mounts"]
        if isinstance(mount, dict)
        and mount.get("Type") == "volume"
        and mount.get("Destination") == destination
        and isinstance(mount.get("Name"), str)
    ]
    return matches[0]["Name"] if len(matches) == 1 else None


def load_live(args: argparse.Namespace) -> dict[str, dict[str, Any]]:
    paths = {
        "app": args.app_inspect,
        "export-cleanup": args.export_inspect,
        "retention-scan": args.retention_inspect,
        "libsql": args.libsql_inspect,
        "caddy": args.caddy_inspect,
    }
    return {service: read_inspect(paths[service], service) for service in ALL_SERVICES}


def classify_live(baseline: dict[str, Any], live: dict[str, dict[str, Any]]) -> tuple[str, str]:
    baseline_containers = {item["service"]: item for item in baseline["containers"]}
    if {item.get("project") for item in live.values()} != {baseline.get("composeProjectName")}:
        return "UNKNOWN", "COMPOSE_PROJECT_DRIFT"
    for service in PRESERVED:
        current = live[service]
        bound = baseline_containers[service]
        if (
            current.get("containerId") != bound.get("containerId")
            or current.get("imageId") != bound.get("imageId")
            or current.get("imageReference") != bound.get("imageReference")
        ):
            return "UNKNOWN", "PRESERVED_SERVICE_IDENTITY_DRIFT"
        if current.get("status") != "running" or (service == "libsql" and current.get("healthStatus") != "healthy"):
            return "UNKNOWN", "PRESERVED_SERVICE_HEALTH_DRIFT"
    for service in MUTABLE:
        current = live[service]
        bound = baseline_containers[service]
        if current.get("imageId") != bound.get("imageId") or current.get("imageReference") != bound.get("imageReference"):
            return "UNKNOWN", "MUTABLE_SERVICE_IMAGE_DRIFT"
        if current.get("status") != "running" or (service == "app" and current.get("healthStatus") != "healthy"):
            return "UNKNOWN", "MUTABLE_SERVICE_HEALTH_DRIFT"
    expected_data = baseline["dataVolumes"]
    current_data = {
        role: mount_name(live[service], destination)
        for role, (service, destination) in DATA_VOLUME_DESTINATIONS.items()
    }
    if current_data != expected_data:
        return "UNKNOWN", "ACTIVE_DATA_VOLUME_DRIFT"
    if (
        mount_name(live["export-cleanup"], "/var/lib/masters/exports") != expected_data["tenantExports"]
        or mount_name(live["export-cleanup"], "/var/lib/masters/data-subject-delivery-packages") != expected_data["dataSubjectDelivery"]
    ):
        return "UNKNOWN", "SHARED_DATA_VOLUME_DRIFT"
    current_caddy = {role: mount_name(live["caddy"], destination) for role, destination in CADDY_VOLUME_DESTINATIONS.items()}
    if current_caddy != baseline["caddyVolumes"]:
        return "UNKNOWN", "CADDY_VOLUME_DRIFT"
    states = [service_state(live[service]) for service in MUTABLE]
    if "UNKNOWN" in states:
        return "UNKNOWN", "MUTABLE_RUNTIME_STATE_UNKNOWN"
    baseline_ids = [baseline_containers[service]["containerId"] for service in MUTABLE]
    current_ids = [live[service]["containerId"] for service in MUTABLE]
    if states == ["DISABLED", "DISABLED", "DISABLED"]:
        return ("BASELINE", "BOUND_PRE_MUTATION_RUNTIME") if current_ids == baseline_ids else ("ROLLBACK", "DISABLED_RUNTIME_RECREATED")
    if states == ["ENABLED", "ENABLED", "ENABLED"]:
        return "TARGET", "TARGET_RUNTIME_ACTIVE"
    return "MIXED_KNOWN", "PARTIAL_KNOWN_RECREATE"


def journal_record_fingerprint(record: dict[str, Any]) -> str:
    return record_fingerprint(record, "journalFingerprint")


def make_journal(
    plan_path: Path,
    plan: dict[str, Any],
    baseline_path: Path,
    baseline_env: dict[str, Any],
    baseline_verification_path: Path,
    baseline_verification_sha: str,
    started_at: str,
) -> dict[str, Any]:
    validate_timestamp(started_at)
    baseline = baseline_env["record"]
    record: dict[str, Any] = {
        "serviceCutoverExecutionJournalVersion": JOURNAL_VERSION,
        "phase": "PENDING",
        "startedAt": started_at,
        "activationId": plan["activationId"],
        "cutoverId": plan["cutoverId"],
        "baselineId": baseline["baselineId"],
        "cutoverPlanFingerprint": plan["cutoverPlanFingerprint"],
        "cutoverPlanFileSha256": sha256_bytes(read_file(plan_path, "SERVICE_CUTOVER_PLAN", private=True)),
        "baselineFingerprint": baseline["baselineFingerprint"],
        "baselineFileSha256": sha256_bytes(read_file(baseline_path, "SERVICE_LIVE_BASELINE", private=True)),
        "baselineSignature": baseline_env["signature"],
        "baselineVerificationPath": str(baseline_verification_path),
        "baselineVerificationFileSha256": baseline_verification_sha,
        "preLiveFingerprint": baseline["liveStateFingerprint"],
        "targetHandoffFingerprint": baseline["targetHandoffFingerprint"],
        "targetPrivacyEnvironment": TARGET,
        "recreateServices": list(MUTABLE),
        "preserveServices": list(PRESERVED),
        "baselineVerifiedBeforeJournal": True,
        "journalRequiredBeforeMutation": True,
        "rollbackStartedRequiredBeforeReverseMutation": True,
        "preservedIdentityRequiredThroughout": True,
        "dataVolumesMustRemainBound": True,
        "serviceMutationStarted": False,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }
    record["journalFingerprint"] = journal_record_fingerprint(record)
    return record


def ensure_dir(root: Path, cutover_id: str, create: bool) -> Path:
    if not root.is_absolute():
        fail("SERVICE_CUTOVER_EXECUTION_ROOT_NOT_ABSOLUTE", "execution root must be absolute")
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir() or stat.S_IMODE(root.stat().st_mode) & 0o077:
        fail("SERVICE_CUTOVER_EXECUTION_ROOT_UNSAFE", "execution root is unsafe")
    directory = root / cutover_id
    if create:
        directory.mkdir(exist_ok=True, mode=0o700)
    if directory.is_symlink() or not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) & 0o077:
        fail("SERVICE_CUTOVER_EXECUTION_DIR_UNSAFE", "execution directory is unsafe")
    return directory


def persist_once(path: Path, envelope: dict[str, Any]) -> bool:
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    return True


def verify_journal(
    path: Path,
    key: bytes,
    plan_path: Path,
    baseline_path: Path,
    baseline_verification_path: Path,
    baseline_verification_sha: str,
    plan: dict[str, Any],
    baseline_env: dict[str, Any],
) -> dict[str, Any]:
    envelope = verify_signed_envelope(path, "SERVICE_CUTOVER_EXECUTION_JOURNAL", JOURNAL_DOMAIN, key)
    record = envelope["record"]
    baseline = baseline_env["record"]
    if record.get("serviceCutoverExecutionJournalVersion") != JOURNAL_VERSION or record.get("phase") != "PENDING":
        fail("SERVICE_CUTOVER_EXECUTION_JOURNAL_VERSION_INVALID", "journal version/phase is invalid")
    validate_timestamp(record.get("startedAt") or "")
    expected = {
        "activationId": plan["activationId"],
        "cutoverId": plan["cutoverId"],
        "baselineId": baseline["baselineId"],
        "cutoverPlanFingerprint": plan["cutoverPlanFingerprint"],
        "cutoverPlanFileSha256": sha256_bytes(read_file(plan_path, "SERVICE_CUTOVER_PLAN", private=True)),
        "baselineFingerprint": baseline["baselineFingerprint"],
        "baselineFileSha256": sha256_bytes(read_file(baseline_path, "SERVICE_LIVE_BASELINE", private=True)),
        "baselineSignature": baseline_env["signature"],
        "baselineVerificationPath": str(baseline_verification_path),
        "baselineVerificationFileSha256": baseline_verification_sha,
        "preLiveFingerprint": baseline["liveStateFingerprint"],
        "targetHandoffFingerprint": baseline["targetHandoffFingerprint"],
        "targetPrivacyEnvironment": TARGET,
        "recreateServices": list(MUTABLE),
        "preserveServices": list(PRESERVED),
    }
    for field, value in expected.items():
        if record.get(field) != value:
            fail("SERVICE_CUTOVER_EXECUTION_JOURNAL_BINDING_MISMATCH", f"journal field {field} differs")
    for field in (
        "baselineVerifiedBeforeJournal",
        "journalRequiredBeforeMutation",
        "rollbackStartedRequiredBeforeReverseMutation",
        "preservedIdentityRequiredThroughout",
        "dataVolumesMustRemainBound",
    ):
        if record.get(field) is not True:
            fail("SERVICE_CUTOVER_EXECUTION_JOURNAL_POLICY_INVALID", f"{field} must be true")
    if any(record.get(field) is not False for field in ("serviceMutationStarted", "serviceCutoverExecuted", "liveRuntimeAttested", "activationExecuted")):
        fail("SERVICE_CUTOVER_EXECUTION_JOURNAL_BOUNDARY_INVALID", "journal must remain pre-mutation")
    fingerprint = record.get("journalFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint) or not hmac.compare_digest(fingerprint, journal_record_fingerprint(record)):
        fail("SERVICE_CUTOVER_EXECUTION_JOURNAL_FINGERPRINT_MISMATCH", "journal fingerprint does not match")
    return envelope


def validate_attestation(path: Path, phase: str) -> str:
    raw = read_file(path, "SERVICE_CUTOVER_LIVE_ATTESTATION", private=True)
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_CUTOVER_LIVE_ATTESTATION_INVALID: attestation is not JSON") from exc
    if not isinstance(result, dict) or result.get("status") != "VERIFIED":
        fail("SERVICE_CUTOVER_LIVE_ATTESTATION_INVALID", "attestation status must be VERIFIED")
    expected_state = "ENABLED" if phase == "LIVE_VALIDATED" else "DISABLED"
    if result.get("backupState") != expected_state:
        fail("SERVICE_CUTOVER_LIVE_ATTESTATION_STATE_MISMATCH", f"{phase} requires {expected_state}")
    return sha256_bytes(raw)


def event_record(phase: str, journal: dict[str, Any], events: list[dict[str, Any]], recorded_at: str, attestation_sha: str | None) -> dict[str, Any]:
    if phase not in PHASES:
        fail("SERVICE_CUTOVER_EXECUTION_PHASE_INVALID", "execution phase is invalid")
    validate_timestamp(recorded_at)
    previous_phase = events[-1]["record"]["phase"] if events else None
    if phase not in TRANSITIONS.get(previous_phase, ()):
        fail("SERVICE_CUTOVER_EXECUTION_TRANSITION_INVALID", f"phase {phase} is not allowed after {previous_phase}")
    if phase in ATTESTATION_PHASES:
        if not isinstance(attestation_sha, str) or not SHA256.fullmatch(attestation_sha):
            fail("SERVICE_CUTOVER_EXECUTION_ATTESTATION_REQUIRED", f"{phase} requires attestation SHA-256")
    elif attestation_sha is not None:
        fail("SERVICE_CUTOVER_EXECUTION_ATTESTATION_UNEXPECTED", "attestation is only allowed for validation phases")
    journal_record = journal["record"]
    return {
        "serviceCutoverExecutionEventVersion": EVENT_VERSION,
        "sequence": len(events) + 1,
        "phase": phase,
        "recordedAt": recorded_at,
        "activationId": journal_record["activationId"],
        "cutoverId": journal_record["cutoverId"],
        "baselineId": journal_record["baselineId"],
        "journalFingerprint": journal_record["journalFingerprint"],
        "journalSignature": journal["signature"],
        "previousEventSignature": events[-1]["signature"] if events else None,
        "liveAttestationSha256": attestation_sha,
        "serviceMutationStarted": True,
        "serviceCutoverExecuted": phase == "COMPLETED",
        "liveRuntimeAttested": phase in {"LIVE_VALIDATED", "COMPLETED"},
        "activationExecuted": phase == "COMPLETED",
        "terminal": phase in TERMINAL,
    }


def read_event(path: Path, key: bytes, journal: dict[str, Any]) -> dict[str, Any]:
    envelope = verify_signed_envelope(path, "SERVICE_CUTOVER_EXECUTION_EVENT", EVENT_DOMAIN, key)
    record = envelope["record"]
    if record.get("serviceCutoverExecutionEventVersion") != EVENT_VERSION or PHASE_FILE.get(record.get("phase")) != path.name:
        fail("SERVICE_CUTOVER_EXECUTION_EVENT_INVALID", "event version/filename is invalid")
    validate_timestamp(record.get("recordedAt") or "")
    journal_record = journal["record"]
    for field in ("activationId", "cutoverId", "baselineId", "journalFingerprint"):
        if record.get(field) != journal_record[field]:
            fail("SERVICE_CUTOVER_EXECUTION_EVENT_BINDING_MISMATCH", f"event {field} differs from journal")
    if record.get("journalSignature") != journal["signature"]:
        fail("SERVICE_CUTOVER_EXECUTION_EVENT_BINDING_MISMATCH", "event journal signature differs")
    phase = record["phase"]
    if phase in ATTESTATION_PHASES:
        if not isinstance(record.get("liveAttestationSha256"), str) or not SHA256.fullmatch(record["liveAttestationSha256"]):
            fail("SERVICE_CUTOVER_EXECUTION_ATTESTATION_INVALID", "validation event lacks attestation SHA")
    elif record.get("liveAttestationSha256") is not None:
        fail("SERVICE_CUTOVER_EXECUTION_ATTESTATION_UNEXPECTED", "event contains unexpected attestation")
    if record.get("serviceMutationStarted") is not True:
        fail("SERVICE_CUTOVER_EXECUTION_EVENT_STATE_INVALID", "event must record mutation direction")
    if record.get("serviceCutoverExecuted") is not (phase == "COMPLETED") or record.get("activationExecuted") is not (phase == "COMPLETED"):
        fail("SERVICE_CUTOVER_EXECUTION_EVENT_STATE_INVALID", "terminal execution flags are invalid")
    if record.get("terminal") is not (phase in TERMINAL):
        fail("SERVICE_CUTOVER_EXECUTION_EVENT_STATE_INVALID", "terminal flag is invalid")
    if record.get("liveRuntimeAttested") is not (phase in {"LIVE_VALIDATED", "COMPLETED"}):
        fail("SERVICE_CUTOVER_EXECUTION_EVENT_STATE_INVALID", "liveRuntimeAttested flag is invalid")
    return envelope


def read_events(directory: Path, key: bytes, journal: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    allowed = set(PHASE_FILE.values()) | {JOURNAL_FILE}
    for item in directory.iterdir():
        if item.name.startswith(".") and item.name.endswith(".tmp"):
            continue
        if item.name not in allowed:
            fail("SERVICE_CUTOVER_EXECUTION_ENTRY_UNEXPECTED", f"unexpected evidence entry {item.name}")
        if item.name != JOURNAL_FILE:
            found.append(read_event(item, key, journal))
    found.sort(key=lambda event: event["record"]["sequence"])
    previous_phase: str | None = None
    previous_signature: str | None = None
    for index, event in enumerate(found, start=1):
        record = event["record"]
        if record["sequence"] != index:
            fail("SERVICE_CUTOVER_EXECUTION_SEQUENCE_GAP", "event sequence is not contiguous")
        if record["previousEventSignature"] != previous_signature:
            fail("SERVICE_CUTOVER_EXECUTION_SIGNATURE_CHAIN_BROKEN", "event signature chain is broken")
        if record["phase"] not in TRANSITIONS.get(previous_phase, ()):
            fail("SERVICE_CUTOVER_EXECUTION_TRANSITION_INVALID", "event transition is invalid")
        previous_phase = record["phase"]
        previous_signature = event["signature"]
    return found


def assess_state(live_class: str, live_reason: str, events: list[dict[str, Any]], journal: dict[str, Any]) -> dict[str, Any]:
    last = events[-1]["record"]["phase"] if events else None
    status = "BLOCKED"
    reason = live_reason
    mutation_allowed = False
    if live_class == "UNKNOWN":
        status = "BLOCKED"
    elif last is None:
        if live_class == "BASELINE":
            status, reason = "READY_TO_START", "LIVE_BASELINE_STILL_ACTIVE"
        else:
            status, reason = "BLOCKED", "LIVE_STATE_CHANGED_WITHOUT_CUTOVER_STARTED"
    elif last == "CUTOVER_STARTED":
        if live_class in {"BASELINE", "MIXED_KNOWN"}:
            status, mutation_allowed = "READY_TO_RECREATE_TARGET", True
        elif live_class == "TARGET":
            status, reason = "RECOVER_TARGET_RECREATED", "TARGET_RECREATE_OUTRAN_EVENT"
        else:
            status, reason = "BLOCKED", "DISABLED_RECREATE_WITHOUT_ROLLBACK_STARTED"
    elif last == "TARGET_RECREATED":
        if live_class == "TARGET":
            status = "READY_TO_VALIDATE_LIVE"
        else:
            status, reason = "BLOCKED", "TARGET_RECREATED_EVENT_CONFLICTS_WITH_LIVE_STATE"
    elif last == "LIVE_VALIDATED":
        if live_class == "TARGET":
            status = "READY_TO_COMPLETE"
        else:
            status, reason = "BLOCKED", "LIVE_VALIDATED_EVENT_CONFLICTS_WITH_LIVE_STATE"
    elif last == "COMPLETED":
        if live_class == "TARGET":
            status = "COMPLETED"
        else:
            status, reason = "BLOCKED", "COMPLETED_EVENT_CONFLICTS_WITH_LIVE_STATE"
    elif last == "ROLLBACK_STARTED":
        if live_class in {"TARGET", "MIXED_KNOWN"}:
            status, mutation_allowed = "READY_TO_RECREATE_ROLLBACK", True
        elif live_class in {"BASELINE", "ROLLBACK"}:
            status, reason = "RECOVER_ROLLBACK_RECREATED", "ROLLBACK_RECREATE_OUTRAN_EVENT"
    elif last == "ROLLBACK_RECREATED":
        if live_class in {"BASELINE", "ROLLBACK"}:
            status = "READY_TO_VERIFY_ROLLBACK"
        else:
            status, reason = "BLOCKED", "ROLLBACK_RECREATED_EVENT_CONFLICTS_WITH_LIVE_STATE"
    elif last == "ROLLBACK_VERIFIED":
        if live_class in {"BASELINE", "ROLLBACK"}:
            status = "ROLLED_BACK"
        else:
            status, reason = "BLOCKED", "ROLLBACK_VERIFIED_EVENT_CONFLICTS_WITH_LIVE_STATE"
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION_ASSESSMENT",
        "status": status,
        "reason": reason,
        "activationId": journal["record"]["activationId"],
        "cutoverId": journal["record"]["cutoverId"],
        "baselineId": journal["record"]["baselineId"],
        "journalFingerprint": journal["record"]["journalFingerprint"],
        "liveState": live_class,
        "eventCount": len(events),
        "lastPhase": last,
        "nextAllowedEvents": list(TRANSITIONS.get(last, ())),
        "serviceMutationAllowed": mutation_allowed,
        "serviceCutoverExecuted": status == "COMPLETED",
        "liveRuntimeAttested": last in {"LIVE_VALIDATED", "COMPLETED"},
        "activationExecuted": status == "COMPLETED",
    }


def common(args: argparse.Namespace) -> tuple[bytes, dict[str, Any], dict[str, Any], str, dict[str, dict[str, Any]], str, str]:
    key = read_key(args.key_file)
    plan_env = verify_plan(args.cutover_plan, key)
    baseline_env = verify_baseline(args.baseline, key, args.cutover_plan, plan_env["record"])
    verification_sha = verify_baseline_authorization(args.baseline_verification, baseline_env["record"], plan_env["record"])
    live = load_live(args)
    live_class, live_reason = classify_live(baseline_env["record"], live)
    return key, plan_env, baseline_env, verification_sha, live, live_class, live_reason


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    key, plan_env, baseline_env, verification_sha, _, live_class, _ = common(args)
    if live_class != "BASELINE":
        fail("SERVICE_CUTOVER_EXECUTION_PRESTATE_INVALID", "journal can only be created while the verified v2 baseline is still active")
    directory = ensure_dir(args.execution_root, plan_env["record"]["cutoverId"], True)
    path = directory / JOURNAL_FILE
    record = make_journal(
        args.cutover_plan,
        plan_env["record"],
        args.baseline,
        baseline_env,
        args.baseline_verification,
        verification_sha,
        args.recorded_at or canonical_now(),
    )
    envelope = {"envelopeVersion": 1, "record": record, "signature": expected_signature(JOURNAL_DOMAIN, record, key)}
    created = persist_once(path, envelope)
    if not created:
        existing = verify_journal(
            path,
            key,
            args.cutover_plan,
            args.baseline,
            args.baseline_verification,
            verification_sha,
            plan_env["record"],
            baseline_env,
        )
        if existing != envelope:
            fail("SERVICE_CUTOVER_EXECUTION_JOURNAL_CONFLICT", "existing journal differs from deterministic request")
        envelope = existing
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION_JOURNAL",
        "status": "SERVICE_CUTOVER_EXECUTION_READY",
        "serviceCutoverExecutionJournalVersion": JOURNAL_VERSION,
        "activationId": record["activationId"],
        "cutoverId": record["cutoverId"],
        "baselineId": record["baselineId"],
        "journalPath": str(path),
        "journalFingerprint": record["journalFingerprint"],
        "journalCreated": created,
        "journalReused": not created,
        "serviceMutationAllowed": False,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }


def assess(args: argparse.Namespace) -> dict[str, Any]:
    key, plan_env, baseline_env, verification_sha, _, live_class, live_reason = common(args)
    journal = verify_journal(
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
        fail("SERVICE_CUTOVER_EXECUTION_JOURNAL_PATH_MISMATCH", "journal parent does not match cutover ID")
    events = read_events(args.journal.parent, key, journal)
    return assess_state(live_class, live_reason, events, journal)


def event(args: argparse.Namespace) -> dict[str, Any]:
    key, plan_env, baseline_env, verification_sha, _, live_class, live_reason = common(args)
    journal = verify_journal(
        args.journal,
        key,
        args.cutover_plan,
        args.baseline,
        args.baseline_verification,
        verification_sha,
        plan_env["record"],
        baseline_env,
    )
    events = read_events(args.journal.parent, key, journal)
    current = assess_state(live_class, live_reason, events, journal)
    phase = args.phase
    allowed_by_state = {
        "CUTOVER_STARTED": {"READY_TO_START"},
        "TARGET_RECREATED": {"RECOVER_TARGET_RECREATED"},
        "LIVE_VALIDATED": {"READY_TO_VALIDATE_LIVE"},
        "COMPLETED": {"READY_TO_COMPLETE"},
        "ROLLBACK_STARTED": {"READY_TO_RECREATE_TARGET", "RECOVER_TARGET_RECREATED", "READY_TO_VALIDATE_LIVE", "READY_TO_COMPLETE"},
        "ROLLBACK_RECREATED": {"RECOVER_ROLLBACK_RECREATED"},
        "ROLLBACK_VERIFIED": {"READY_TO_VERIFY_ROLLBACK"},
    }
    if current["status"] not in allowed_by_state.get(phase, set()):
        fail("SERVICE_CUTOVER_EXECUTION_EVENT_LIVE_STATE_INVALID", f"cannot persist {phase} while assessment is {current['status']}")
    existing = next((item for item in events if item["record"]["phase"] == phase), None)
    if existing is not None:
        return {
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION_EVENT",
            "status": "EVENT_REUSED",
            "phase": phase,
            "sequence": existing["record"]["sequence"],
            "eventPath": str(args.journal.parent / PHASE_FILE[phase]),
            "eventSignature": existing["signature"],
            "serviceMutationApplied": False,
            "activationExecuted": existing["record"]["activationExecuted"],
        }
    attestation_sha = None
    if phase in ATTESTATION_PHASES:
        if args.attestation is None:
            fail("SERVICE_CUTOVER_EXECUTION_ATTESTATION_REQUIRED", f"{phase} requires an attestation file")
        attestation_sha = validate_attestation(args.attestation, phase)
    elif args.attestation is not None:
        fail("SERVICE_CUTOVER_EXECUTION_ATTESTATION_UNEXPECTED", "attestation is only valid for validation phases")
    record = event_record(phase, journal, events, args.recorded_at or canonical_now(), attestation_sha)
    envelope = {"envelopeVersion": 1, "record": record, "signature": expected_signature(EVENT_DOMAIN, record, key)}
    path = args.journal.parent / PHASE_FILE[phase]
    created = persist_once(path, envelope)
    if not created:
        observed = read_event(path, key, journal)
        if observed != envelope:
            fail("SERVICE_CUTOVER_EXECUTION_EVENT_CONFLICT", "existing event differs")
        envelope = observed
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION_EVENT",
        "status": "EVENT_PERSISTED" if created else "EVENT_REUSED",
        "phase": phase,
        "sequence": envelope["record"]["sequence"],
        "eventPath": str(path),
        "eventSignature": envelope["signature"],
        "serviceMutationApplied": False,
        "serviceCutoverExecuted": phase == "COMPLETED",
        "liveRuntimeAttested": phase in {"LIVE_VALIDATED", "COMPLETED"},
        "activationExecuted": phase == "COMPLETED",
    }


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cutover-plan", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--baseline-verification", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--app-inspect", required=True, type=Path)
    parser.add_argument("--export-inspect", required=True, type=Path)
    parser.add_argument("--retention-inspect", required=True, type=Path)
    parser.add_argument("--libsql-inspect", required=True, type=Path)
    parser.add_argument("--caddy-inspect", required=True, type=Path)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p_prepare = sub.add_parser("prepare")
    add_common(p_prepare)
    p_prepare.add_argument("--execution-root", required=True, type=Path)
    p_prepare.add_argument("--recorded-at")
    p_assess = sub.add_parser("assess")
    add_common(p_assess)
    p_assess.add_argument("--journal", required=True, type=Path)
    p_event = sub.add_parser("event")
    add_common(p_event)
    p_event.add_argument("--journal", required=True, type=Path)
    p_event.add_argument("--phase", required=True, choices=PHASES)
    p_event.add_argument("--recorded-at")
    p_event.add_argument("--attestation", type=Path)
    args = parser.parse_args()
    try:
        if getattr(args, "recorded_at", None) is not None:
            validate_timestamp(args.recorded_at)
        result = prepare(args) if args.command == "prepare" else assess(args) if args.command == "assess" else event(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0 if result.get("status") != "BLOCKED" else 1
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "serviceMutationAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())