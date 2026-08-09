#!/usr/bin/env python3
"""Read-only helpers for backup-privacy service live-baseline evidence v2."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
PRIVACY_ENV_KEYS = (
    "PRIVACY_BACKUP_STATE",
    "PRIVACY_BACKUP_POLICY_VERSION",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION",
    "PRIVACY_NOTIFICATIONS_STATE",
    "PRIVACY_NOTIFICATIONS_POLICY_VERSION",
    "PRIVACY_NOTIFICATIONS_SUBJECT_SCOPED_PAYLOAD",
    "PRIVACY_NOTIFICATIONS_DIRECT_IDENTIFIERS_FORBIDDEN",
    "PRIVACY_NOTIFICATIONS_SUBJECT_CLEANUP_SUPPORTED",
)
RUNTIME_SERVICES = ("app", "export-cleanup", "retention-scan")
PRESERVE_SERVICES = ("libsql", "caddy")
ALL_SERVICES = (*RUNTIME_SERVICES, *PRESERVE_SERVICES)
HEALTH_REQUIRED = ("app", "libsql")
CADDY_VOLUME_TARGETS = {"data": "/data", "config": "/config"}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_file(path: Path, code: str, *, private: bool = False) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{code}_UNSAFE", "file must be an absolute regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o022:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must not be group/world writable")
    if private and mode & 0o077:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must be private")
    return path.read_bytes()


def verify_cutover_plan(
    checker: Path,
    *,
    handoff_checker: Path,
    activation_plan_checker: Path,
    execution_evidence_checker: Path,
    target_config_checker: Path,
    activation_plan: Path,
    pending: Path,
    handoff: Path,
    key_file: Path,
    env_file: Path,
    compose_file: Path,
    cutover_plan: Path,
) -> dict[str, Any]:
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("SERVICE_CUTOVER_PLAN_CHECKER_UNSAFE", "cutover-plan checker must be an absolute regular file")
    proc = subprocess.run(
        [
            sys.executable,
            str(checker),
            "--handoff-checker", str(handoff_checker),
            "--activation-plan-checker", str(activation_plan_checker),
            "--execution-evidence-checker", str(execution_evidence_checker),
            "--target-config-checker", str(target_config_checker),
            "--activation-plan", str(activation_plan),
            "--pending", str(pending),
            "--handoff", str(handoff),
            "--key-file", str(key_file),
            "--env-file", str(env_file),
            "--compose-file", str(compose_file),
            "--cutover-plan", str(cutover_plan),
        ],
        check=False,
        capture_output=True,
    )
    try:
        result = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("SERVICE_CUTOVER_PLAN_CHECK_OUTPUT_INVALID: checker did not return JSON") from exc
    if not isinstance(result, dict):
        fail("SERVICE_CUTOVER_PLAN_CHECK_OUTPUT_INVALID", "checker output must be an object")
    if (
        proc.returncode != 0
        or result.get("status") != "SERVICE_CUTOVER_PLAN_VERIFIED"
        or result.get("serviceCutoverPlanVersion") != 2
        or result.get("liveBaselineRequired") is not True
        or result.get("serviceCutoverExecutionAllowed") is not False
        or result.get("serviceCutoverExecuted") is not False
        or result.get("liveRuntimeAttested") is not False
        or result.get("activationExecuted") is not False
    ):
        fail("SERVICE_CUTOVER_PLAN_NOT_VERIFIED", f"cutover plan verification failed: {result.get('blocker')}")
    return result


def read_cutover_record(path: Path, verified: dict[str, Any]) -> dict[str, Any]:
    raw = read_file(path, "SERVICE_CUTOVER_PLAN", private=True)
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_CUTOVER_PLAN_INVALID: plan is not JSON") from exc
    record = envelope.get("record") if isinstance(envelope, dict) else None
    if not isinstance(record, dict) or record.get("serviceCutoverPlanVersion") != 2:
        fail("SERVICE_CUTOVER_PLAN_INVALID", "cutover-plan record must be v2")
    for field in (
        "cutoverId",
        "activationId",
        "cutoverPlanFingerprint",
        "targetHandoffFingerprint",
        "renderedComposeSha256",
    ):
        if verified.get(field) != record.get(field):
            fail("SERVICE_CUTOVER_PLAN_BINDING_MISMATCH", f"verified {field} differs from signed record")
    for field in ("liveBaselineRequiredBeforeMutation", "targetHandoffMustRemainVerified"):
        if record.get(field) is not True:
            fail("SERVICE_CUTOVER_PLAN_POLICY_INVALID", f"{field} must be true")
    for field in ("serviceCutoverExecuted", "liveRuntimeAttested", "activationExecuted"):
        if record.get(field) is not False:
            fail("SERVICE_CUTOVER_PLAN_BOUNDARY_INVALID", f"{field} must remain false")
    return record


def render_compose(compose_file: Path, env_file: Path, expected_sha: str) -> dict[str, Any]:
    read_file(compose_file, "SERVICE_CUTOVER_COMPOSE")
    read_file(env_file, "ENV_FILE", private=True)
    proc = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(compose_file), "config", "--format", "json"],
        check=False,
        capture_output=True,
    )
    if proc.returncode != 0:
        fail("SERVICE_LIVE_BASELINE_COMPOSE_RENDER_FAILED", proc.stderr.decode("utf-8", errors="replace")[:300])
    try:
        rendered = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_COMPOSE_RENDER_INVALID: compose config did not return JSON") from exc
    if not isinstance(rendered, dict):
        fail("SERVICE_LIVE_BASELINE_COMPOSE_RENDER_INVALID", "rendered compose must be an object")
    actual_sha = sha256_bytes((canonical_json(rendered) + "\n").encode("utf-8"))
    if actual_sha != expected_sha:
        fail("SERVICE_LIVE_BASELINE_COMPOSE_DRIFT", "rendered compose no longer matches signed cutover plan")
    project = rendered.get("name")
    if not isinstance(project, str) or not project or len(project) > 128:
        fail("SERVICE_LIVE_BASELINE_PROJECT_INVALID", "rendered compose project name is invalid")
    return rendered


def resolve_container_id(project: str, service: str) -> str:
    proc = subprocess.run(
        [
            "docker", "ps", "-a", "--no-trunc",
            "--filter", f"label=com.docker.compose.project={project}",
            "--filter", f"label=com.docker.compose.service={service}",
            "--format", "{{.ID}}",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        fail("SERVICE_LIVE_BASELINE_DOCKER_PS_FAILED", proc.stderr[:300])
    ids = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if len(ids) != 1:
        fail("SERVICE_LIVE_BASELINE_CONTAINER_CARDINALITY", f"{service} must resolve exactly once, found {len(ids)}")
    container_id = ids[0]
    if not CONTAINER_ID.fullmatch(container_id):
        fail("SERVICE_LIVE_BASELINE_CONTAINER_ID_INVALID", f"{service} container ID is invalid")
    return container_id


def inspect_container(container_id: str, project: str, service: str) -> dict[str, Any]:
    proc = subprocess.run(["docker", "inspect", container_id], check=False, capture_output=True)
    if proc.returncode != 0:
        fail("SERVICE_LIVE_BASELINE_DOCKER_INSPECT_FAILED", proc.stderr.decode("utf-8", errors="replace")[:300])
    try:
        raw = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_DOCKER_INSPECT_INVALID: inspect did not return JSON") from exc
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        fail("SERVICE_LIVE_BASELINE_DOCKER_INSPECT_INVALID", f"{service} inspect must contain exactly one object")
    container = raw[0]
    if container.get("Id") != container_id:
        fail("SERVICE_LIVE_BASELINE_CONTAINER_ID_MISMATCH", f"{service} inspect ID mismatch")
    config = container.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    if not isinstance(labels, dict):
        fail("SERVICE_LIVE_BASELINE_LABELS_INVALID", f"{service} labels are invalid")
    if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != service:
        fail("SERVICE_LIVE_BASELINE_CONTAINER_BINDING_MISMATCH", f"{service} is not the expected Compose service")
    if str(labels.get("com.docker.compose.oneoff", "False")).lower() == "true":
        fail("SERVICE_LIVE_BASELINE_ONEOFF_FORBIDDEN", f"{service} unexpectedly resolves to a one-off container")
    return container


def privacy_environment(container: dict[str, Any], service: str) -> dict[str, str]:
    config = container.get("Config")
    raw_env = config.get("Env") if isinstance(config, dict) else None
    if not isinstance(raw_env, list):
        fail("SERVICE_LIVE_BASELINE_ENV_INVALID", f"{service} Config.Env is invalid")
    values: dict[str, str] = {}
    for item in raw_env:
        if not isinstance(item, str) or "=" not in item:
            continue
        key, value = item.split("=", 1)
        if key not in PRIVACY_ENV_KEYS:
            continue
        if key in values:
            fail("SERVICE_LIVE_BASELINE_PRIVACY_ENV_DUPLICATE", f"{service} has duplicate {key}")
        values[key] = value
    if values.get("PRIVACY_BACKUP_STATE") != "DISABLED":
        fail("SERVICE_LIVE_BASELINE_BACKUP_STATE_NOT_DISABLED", f"{service} is not running with backup privacy DISABLED")
    if values.get("PRIVACY_NOTIFICATIONS_STATE") != "DISABLED":
        fail("SERVICE_LIVE_BASELINE_NOTIFICATIONS_STATE_NOT_DISABLED", f"{service} is not running with notifications privacy DISABLED")
    return {key: values[key] for key in sorted(values)}


def state_snapshot(container: dict[str, Any], service: str) -> dict[str, Any]:
    state = container.get("State")
    if not isinstance(state, dict):
        fail("SERVICE_LIVE_BASELINE_STATE_INVALID", f"{service} state is invalid")
    if state.get("Running") is not True or state.get("Status") != "running":
        fail("SERVICE_LIVE_BASELINE_SERVICE_NOT_RUNNING", f"{service} must be running")
    started_at = state.get("StartedAt")
    if not isinstance(started_at, str) or not started_at:
        fail("SERVICE_LIVE_BASELINE_STARTED_AT_INVALID", f"{service} StartedAt is invalid")
    health_status: str | None = None
    health = state.get("Health")
    if isinstance(health, dict):
        status = health.get("Status")
        if isinstance(status, str):
            health_status = status
    if service in HEALTH_REQUIRED and health_status != "healthy":
        fail("SERVICE_LIVE_BASELINE_SERVICE_NOT_HEALTHY", f"{service} must be healthy")
    restart_count = container.get("RestartCount")
    if not isinstance(restart_count, int) or restart_count < 0:
        fail("SERVICE_LIVE_BASELINE_RESTART_COUNT_INVALID", f"{service} restart count is invalid")
    return {
        "running": True,
        "status": "running",
        "healthStatus": health_status,
        "startedAt": started_at,
        "restartCount": restart_count,
    }


def container_snapshot(container: dict[str, Any], project: str, service: str) -> dict[str, Any]:
    container_id = container.get("Id")
    image_id = container.get("Image")
    config = container.get("Config")
    image_ref = config.get("Image") if isinstance(config, dict) else None
    name = container.get("Name")
    if not isinstance(container_id, str) or not CONTAINER_ID.fullmatch(container_id):
        fail("SERVICE_LIVE_BASELINE_CONTAINER_ID_INVALID", f"{service} container ID is invalid")
    if not isinstance(image_id, str) or not SHA256.fullmatch(image_id):
        fail("SERVICE_LIVE_BASELINE_IMAGE_ID_INVALID", f"{service} image ID is invalid")
    if not isinstance(image_ref, str) or not image_ref or len(image_ref) > 512:
        fail("SERVICE_LIVE_BASELINE_IMAGE_REF_INVALID", f"{service} image reference is invalid")
    if not isinstance(name, str) or not name.startswith("/") or len(name) > 256:
        fail("SERVICE_LIVE_BASELINE_CONTAINER_NAME_INVALID", f"{service} container name is invalid")
    snapshot: dict[str, Any] = {
        "service": service,
        "composeProject": project,
        "containerId": container_id,
        "containerName": name[1:],
        "imageId": image_id,
        "imageReference": image_ref,
        **state_snapshot(container, service),
    }
    if service in RUNTIME_SERVICES:
        snapshot["privacyEnvironment"] = privacy_environment(container, service)
    return snapshot


def load_volume_resolver(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("SERVICE_LIVE_BASELINE_VOLUME_RESOLVER_UNSAFE", "volume resolver must be an absolute regular file")
    spec = importlib.util.spec_from_file_location("active_club_volume_resolver", path)
    if spec is None or spec.loader is None:
        fail("SERVICE_LIVE_BASELINE_VOLUME_RESOLVER_INVALID", "could not load volume resolver")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "resolve", None)):
        fail("SERVICE_LIVE_BASELINE_VOLUME_RESOLVER_INVALID", "volume resolver does not expose resolve")
    return module


def caddy_volumes(rendered: dict[str, Any], caddy: dict[str, Any]) -> dict[str, str]:
    services = rendered.get("services")
    service = services.get("caddy") if isinstance(services, dict) else None
    if not isinstance(service, dict):
        fail("SERVICE_LIVE_BASELINE_CADDY_COMPOSE_INVALID", "rendered compose is missing caddy")
    compose_volumes = service.get("volumes")
    top_level = rendered.get("volumes")
    mounts = caddy.get("Mounts")
    if not isinstance(compose_volumes, list) or not isinstance(top_level, dict) or not isinstance(mounts, list):
        fail("SERVICE_LIVE_BASELINE_CADDY_VOLUME_INVALID", "caddy volume metadata is invalid")
    result: dict[str, str] = {}
    for role, target in CADDY_VOLUME_TARGETS.items():
        compose_matches = [
            item for item in compose_volumes
            if isinstance(item, dict)
            and item.get("type") == "volume"
            and item.get("target") == target
            and isinstance(item.get("source"), str)
        ]
        if len(compose_matches) != 1:
            fail("SERVICE_LIVE_BASELINE_CADDY_VOLUME_INVALID", f"caddy {target} must resolve exactly once in Compose")
        logical = compose_matches[0]["source"]
        definition = top_level.get(logical)
        expected_name = definition.get("name") if isinstance(definition, dict) else None
        mount_matches = [
            item for item in mounts
            if isinstance(item, dict)
            and item.get("Type") == "volume"
            and item.get("Destination") == target
            and isinstance(item.get("Name"), str)
        ]
        if len(mount_matches) != 1:
            fail("SERVICE_LIVE_BASELINE_CADDY_VOLUME_INVALID", f"active caddy {target} volume must resolve exactly once")
        mount = mount_matches[0]
        if mount.get("RW") is not True:
            fail("SERVICE_LIVE_BASELINE_CADDY_VOLUME_READ_ONLY", f"active caddy {target} volume is read-only")
        actual = mount["Name"]
        if isinstance(expected_name, str) and expected_name and actual != expected_name:
            fail("SERVICE_LIVE_BASELINE_CADDY_VOLUME_MISMATCH", f"active caddy {target} volume differs from rendered Compose")
        result[role] = actual
    if len(set(result.values())) != len(result):
        fail("SERVICE_LIVE_BASELINE_CADDY_VOLUME_COLLISION", "caddy data/config must be distinct named volumes")
    return result


def collect_live_state(rendered: dict[str, Any], volume_resolver: Path) -> dict[str, Any]:
    project = rendered.get("name")
    if not isinstance(project, str) or not project:
        fail("SERVICE_LIVE_BASELINE_PROJECT_INVALID", "rendered compose project name is missing")
    containers: dict[str, dict[str, Any]] = {}
    snapshots: list[dict[str, Any]] = []
    for service in ALL_SERVICES:
        container_id = resolve_container_id(project, service)
        container = inspect_container(container_id, project, service)
        containers[service] = container
        snapshots.append(container_snapshot(container, project, service))
    resolver = load_volume_resolver(volume_resolver)
    try:
        data_volumes = resolver.resolve(rendered, containers["app"], containers["libsql"])
    except ValueError as exc:
        raise ValueError(f"SERVICE_LIVE_BASELINE_DATA_VOLUME_INVALID: {exc}") from exc
    if not isinstance(data_volumes, dict) or set(data_volumes) != {"libsql", "reports", "tenantExports", "dataSubjectDelivery"}:
        fail("SERVICE_LIVE_BASELINE_DATA_VOLUME_INVALID", "active data-volume resolution is incomplete")
    caddy_volume_state = caddy_volumes(rendered, containers["caddy"])
    snapshots.sort(key=lambda item: item["service"])
    return {
        "composeProjectName": project,
        "containers": snapshots,
        "dataVolumes": {key: data_volumes[key] for key in sorted(data_volumes)},
        "caddyVolumes": {key: caddy_volume_state[key] for key in sorted(caddy_volume_state)},
    }


def live_state_fingerprint(state: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(state).encode("utf-8"))
