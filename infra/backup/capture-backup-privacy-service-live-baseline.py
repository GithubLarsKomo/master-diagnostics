#!/usr/bin/env python3
"""Capture a signed read-only live service baseline before backup-privacy cutover."""
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

BASELINE_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-service-live-baseline:v1\n"
CUTOVER_PLAN_DOMAIN = b"masters:backup-privacy-service-cutover-plan:v1\n"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CUTOVER_ID = re.compile(r"^cutover-[0-9a-f]{32}$")
DOCKER_ID = re.compile(r"^[0-9a-f]{64}$")
DOCKER_VOLUME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
RECREATE_SERVICES = ("app", "export-cleanup", "retention-scan")
PRESERVE_SERVICES = ("libsql", "caddy")
ROLE_TARGETS = {
    "libsql": ("libsql", "/var/lib/sqld"),
    "reports": ("app", "/var/lib/masters/reports"),
    "tenantExports": ("app", "/var/lib/masters/exports"),
    "dataSubjectDelivery": ("app", "/var/lib/masters/data-subject-delivery-packages"),
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
    raw = read_file(path, "LIVE_BASELINE_KEY", private=True)
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("LIVE_BASELINE_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("LIVE_BASELINE_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def verify_cutover_plan(path: Path, key: bytes) -> tuple[dict[str, Any], str]:
    raw = read_file(path, "SERVICE_CUTOVER_PLAN", private=True)
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_CUTOVER_PLAN_INVALID: plan is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("SERVICE_CUTOVER_PLAN_INVALID", "plan envelope is invalid")
    record = envelope["record"]
    signature = envelope.get("signature")
    if record.get("serviceCutoverPlanVersion") != 1:
        fail("SERVICE_CUTOVER_PLAN_VERSION_INVALID", "cutover plan version must be 1")
    cutover_id = record.get("cutoverId")
    if not isinstance(cutover_id, str) or not CUTOVER_ID.fullmatch(cutover_id):
        fail("SERVICE_CUTOVER_ID_INVALID", "cutover ID is invalid")
    fingerprint = record.get("cutoverPlanFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("SERVICE_CUTOVER_PLAN_FINGERPRINT_INVALID", "cutover plan fingerprint is invalid")
    body = dict(record); body.pop("cutoverPlanFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode("utf-8"))):
        fail("SERVICE_CUTOVER_PLAN_FINGERPRINT_MISMATCH", "cutover plan fingerprint does not match")
    if record.get("recreateServices") != list(RECREATE_SERVICES) or record.get("preserveServices") != list(PRESERVE_SERVICES):
        fail("SERVICE_CUTOVER_SERVICE_POLICY_INVALID", "cutover service policy is invalid")
    for field in (
        "preflightMustSucceedBeforeMutation",
        "renderedComposeMustRemainBound",
        "caddyContainerMustBePreserved",
        "libsqlContainerMustBePreserved",
        "appHealthcheckRequired",
        "backgroundServicesRunningRequired",
        "liveRuntimeEnvironmentAttestationRequired",
        "rollbackOnCutoverFailureRequired",
    ):
        if record.get(field) is not True:
            fail("SERVICE_CUTOVER_PLAN_POLICY_INVALID", f"{field} must be true")
    if record.get("serviceCutoverExecuted") is not False or record.get("liveRuntimeAttested") is not False:
        fail("SERVICE_CUTOVER_PLAN_BOUNDARY_INVALID", "cutover plan must remain pre-mutation")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("SERVICE_CUTOVER_PLAN_SIGNATURE_INVALID", "cutover plan HMAC is invalid")
    payload = {"envelopeVersion": 1, "record": record}
    expected = "hmac-sha256:" + hmac.new(key, CUTOVER_PLAN_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        fail("SERVICE_CUTOVER_PLAN_SIGNATURE_MISMATCH", "cutover plan HMAC does not match")
    return record, signature


def read_rendered_compose(path: Path, plan: dict[str, Any]) -> dict[str, Any]:
    raw = read_file(path, "LIVE_BASELINE_COMPOSE_JSON")
    try:
        rendered = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("LIVE_BASELINE_COMPOSE_JSON_INVALID: rendered Compose evidence is not JSON") from exc
    if not isinstance(rendered, dict):
        fail("LIVE_BASELINE_COMPOSE_JSON_INVALID", "rendered Compose evidence must be an object")
    normalized = (canonical_json(rendered) + "\n").encode("utf-8")
    if sha256_bytes(normalized) != plan.get("renderedComposeSha256"):
        fail("LIVE_BASELINE_COMPOSE_DRIFT", "rendered Compose no longer matches signed cutover plan")
    project = rendered.get("name")
    if not isinstance(project, str) or not project:
        fail("LIVE_BASELINE_COMPOSE_PROJECT_INVALID", "rendered Compose project name is missing")
    return rendered


def inspect_object(path: Path, service: str) -> dict[str, Any]:
    raw = read_file(path, f"LIVE_BASELINE_{service.upper().replace('-', '_')}_INSPECT")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LIVE_BASELINE_INSPECT_INVALID: {service} inspect is not JSON") from exc
    if not isinstance(parsed, list) or len(parsed) != 1 or not isinstance(parsed[0], dict):
        fail("LIVE_BASELINE_INSPECT_INVALID", f"{service} inspect must contain exactly one container")
    return parsed[0]


def env_map(container: dict[str, Any]) -> dict[str, str]:
    values: dict[str, str] = {}
    raw = container.get("Config", {}).get("Env", [])
    if not isinstance(raw, list):
        fail("LIVE_BASELINE_CONTAINER_ENV_INVALID", "container Env must be a list")
    for item in raw:
        if not isinstance(item, str) or "=" not in item:
            continue
        key, value = item.split("=", 1)
        values[key] = value
    return values


def service_snapshot(container: dict[str, Any], service: str, project: str) -> dict[str, Any]:
    container_id = container.get("Id")
    image_id = container.get("Image")
    config = container.get("Config")
    state = container.get("State")
    if not isinstance(container_id, str) or not DOCKER_ID.fullmatch(container_id):
        fail("LIVE_BASELINE_CONTAINER_ID_INVALID", f"{service} container ID is invalid")
    if not isinstance(image_id, str) or not SHA256.fullmatch(image_id):
        fail("LIVE_BASELINE_IMAGE_ID_INVALID", f"{service} image ID is invalid")
    if not isinstance(config, dict) or not isinstance(state, dict):
        fail("LIVE_BASELINE_CONTAINER_INVALID", f"{service} container config/state is invalid")
    labels = config.get("Labels")
    if not isinstance(labels, dict):
        fail("LIVE_BASELINE_CONTAINER_LABELS_INVALID", f"{service} labels are invalid")
    if labels.get("com.docker.compose.service") != service or labels.get("com.docker.compose.project") != project:
        fail("LIVE_BASELINE_CONTAINER_IDENTITY_MISMATCH", f"{service} does not belong to the rendered Compose project")
    if state.get("Status") != "running" or state.get("Running") is not True:
        fail("LIVE_BASELINE_SERVICE_NOT_RUNNING", f"{service} must be running before cutover")
    if service in ("app", "libsql"):
        health = state.get("Health")
        if not isinstance(health, dict) or health.get("Status") != "healthy":
            fail("LIVE_BASELINE_SERVICE_NOT_HEALTHY", f"{service} must be healthy before cutover")
        health_status = "healthy"
    else:
        health_status = "not-configured"
    backup_state: str | None = None
    if service in RECREATE_SERVICES:
        privacy = env_map(container)
        backup_state = privacy.get("PRIVACY_BACKUP_STATE")
        if backup_state != "DISABLED":
            fail("LIVE_BASELINE_BACKUP_STATE_NOT_DISABLED", f"{service} must still run with PRIVACY_BACKUP_STATE=DISABLED")
    return {
        "service": service,
        "containerId": container_id,
        "imageId": image_id,
        "configuredImage": str(config.get("Image") or ""),
        "running": True,
        "healthStatus": health_status,
        "backupPrivacyState": backup_state,
    }


def volume_mount(container: dict[str, Any], service: str, target: str) -> str:
    mounts = container.get("Mounts")
    if not isinstance(mounts, list):
        fail("LIVE_BASELINE_MOUNTS_INVALID", f"{service} mounts are invalid")
    matches = [m for m in mounts if isinstance(m, dict) and m.get("Type") == "volume" and m.get("Destination") == target]
    if len(matches) != 1:
        fail("LIVE_BASELINE_VOLUME_MOUNT_INVALID", f"{service}:{target} must resolve to exactly one named volume")
    mount = matches[0]
    name = mount.get("Name")
    if not isinstance(name, str) or not DOCKER_VOLUME.fullmatch(name) or mount.get("RW") is not True:
        fail("LIVE_BASELINE_VOLUME_MOUNT_INVALID", f"{service}:{target} must be a writable named volume")
    return name


def safe_output_root(path: Path) -> None:
    if not path.is_absolute():
        fail("LIVE_BASELINE_OUTPUT_NOT_ABSOLUTE", "output root must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("LIVE_BASELINE_OUTPUT_UNSAFE", "output root must be a non-symlink directory")
    os.chmod(path, 0o700)


def sign(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def persist(path: Path, envelope: dict[str, Any]) -> bool:
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        raw = read_file(path, "LIVE_BASELINE", private=True).decode("utf-8")
        if raw == serialized:
            return False
        fail("LIVE_BASELINE_CONFLICT", "existing baseline differs from current live state")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush(); os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True); raise
    os.chmod(path, 0o600)
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cutover-plan", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--compose-json", required=True, type=Path)
    parser.add_argument("--app-inspect", required=True, type=Path)
    parser.add_argument("--export-cleanup-inspect", required=True, type=Path)
    parser.add_argument("--retention-scan-inspect", required=True, type=Path)
    parser.add_argument("--libsql-inspect", required=True, type=Path)
    parser.add_argument("--caddy-inspect", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--captured-at")
    args = parser.parse_args()
    try:
        key = read_key(args.key_file)
        plan, plan_signature = verify_cutover_plan(args.cutover_plan, key)
        rendered = read_rendered_compose(args.compose_json, plan)
        project = rendered["name"]
        inspect_paths = {
            "app": args.app_inspect,
            "export-cleanup": args.export_cleanup_inspect,
            "retention-scan": args.retention_scan_inspect,
            "libsql": args.libsql_inspect,
            "caddy": args.caddy_inspect,
        }
        containers = {service: inspect_object(path, service) for service, path in inspect_paths.items()}
        snapshots = [service_snapshot(containers[service], service, project) for service in (*RECREATE_SERVICES, *PRESERVE_SERVICES)]
        volumes = {role: volume_mount(containers[service], service, target) for role, (service, target) in ROLE_TARGETS.items()}
        if len(set(volumes.values())) != len(volumes):
            fail("LIVE_BASELINE_VOLUME_SET_INVALID", "four data volume roles must use distinct named volumes")
        if volume_mount(containers["export-cleanup"], "export-cleanup", "/var/lib/masters/exports") != volumes["tenantExports"]:
            fail("LIVE_BASELINE_BACKGROUND_VOLUME_MISMATCH", "export-cleanup tenant export volume differs from app")
        if volume_mount(containers["export-cleanup"], "export-cleanup", "/var/lib/masters/data-subject-delivery-packages") != volumes["dataSubjectDelivery"]:
            fail("LIVE_BASELINE_BACKGROUND_VOLUME_MISMATCH", "export-cleanup delivery volume differs from app")
        captured_at = args.captured_at or now_utc()
        if not CANONICAL_UTC.fullmatch(captured_at):
            fail("LIVE_BASELINE_TIMESTAMP_INVALID", "capturedAt must use canonical UTC milliseconds")
        record: dict[str, Any] = {
            "liveBaselineVersion": BASELINE_VERSION,
            "cutoverId": plan["cutoverId"],
            "capturedAt": captured_at,
            "cutoverPlanFingerprint": plan["cutoverPlanFingerprint"],
            "cutoverPlanSignature": plan_signature,
            "cutoverPlanFileSha256": sha256_bytes(read_file(args.cutover_plan, "SERVICE_CUTOVER_PLAN", private=True)),
            "renderedComposeSha256": plan["renderedComposeSha256"],
            "composeProject": project,
            "services": snapshots,
            "rollbackDataVolumes": volumes,
            "baselineCapturedBeforeMutation": True,
            "liveBackupState": "DISABLED",
            "libsqlContainerMustRemain": containers["libsql"]["Id"],
            "caddyContainerMustRemain": containers["caddy"]["Id"],
            "serviceMutationStarted": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
        }
        record["liveBaselineFingerprint"] = sha256_bytes(canonical_json(record).encode("utf-8"))
        safe_output_root(args.output_root)
        envelope = {"envelopeVersion": 1, "record": record, "signature": sign(record, key)}
        path = args.output_root / f"{plan['cutoverId']}-live-baseline.json"
        created = persist(path, envelope)
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
            "status": "LIVE_BASELINE_READY",
            "cutoverId": plan["cutoverId"],
            "liveBaselineFingerprint": record["liveBaselineFingerprint"],
            "baselinePath": str(path),
            "baselineCreated": created,
            "baselineReused": not created,
            "serviceCutoverBaselineReady": True,
            "serviceMutationStarted": False,
            "serviceCutoverExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
            "status": "BLOCKED",
            "blocker": blocker,
            "serviceCutoverBaselineReady": False,
            "serviceMutationStarted": False,
            "serviceCutoverExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
