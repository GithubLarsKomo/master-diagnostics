#!/usr/bin/env python3
"""Prepare or verify signed read-only live service baseline before backup-privacy cutover."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

BASELINE_VERSION = 1
ENVELOPE_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-service-live-baseline:v1\n"
BASELINE_FILE = "service-live-baseline.json"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CUTOVER_ID = re.compile(r"^cutover-[0-9a-f]{32}$")
CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
VOLUME_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
RECREATE = ("app", "export-cleanup", "retention-scan")
PRESERVE = ("libsql", "caddy")
PRIVACY_KEYS = (
    "PRIVACY_BACKUP_STATE",
    "PRIVACY_BACKUP_POLICY_VERSION",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION",
    "PRIVACY_NOTIFICATIONS_STATE",
)
MOUNT_TARGETS = {
    "app": {
        "/var/lib/masters/reports": "reports",
        "/var/lib/masters/exports": "tenantExports",
        "/var/lib/masters/data-subject-delivery-packages": "dataSubjectDelivery",
    },
    "export-cleanup": {
        "/var/lib/masters/exports": "tenantExports",
        "/var/lib/masters/data-subject-delivery-packages": "dataSubjectDelivery",
    },
    "libsql": {"/var/lib/sqld": "libsql"},
    "caddy": {"/data": "caddyData", "/config": "caddyConfig"},
    "retention-scan": {},
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


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
    try:
        key = base64.b64decode(read_file(path, "LIVE_BASELINE_KEY", private=True).decode().strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("LIVE_BASELINE_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("LIVE_BASELINE_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def run_json(command: list[str]) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(command, check=False, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("LIVE_BASELINE_DEPENDENCY_OUTPUT_INVALID: command did not return JSON") from exc
    if not isinstance(result, dict):
        fail("LIVE_BASELINE_DEPENDENCY_OUTPUT_INVALID", "dependency output must be a JSON object")
    return proc.returncode, result


def verify_cutover_plan(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    checker = args.cutover_plan_checker
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("LIVE_BASELINE_CUTOVER_CHECKER_UNSAFE", "cutover plan checker is unsafe")
    command = [
        sys.executable,
        str(checker),
        "--handoff-checker", str(args.handoff_checker),
        "--activation-plan-checker", str(args.activation_plan_checker),
        "--execution-evidence-checker", str(args.execution_evidence_checker),
        "--target-config-checker", str(args.target_config_checker),
        "--activation-plan", str(args.activation_plan),
        "--pending", str(args.pending),
        "--handoff", str(args.handoff),
        "--key-file", str(args.key_file),
        "--env-file", str(args.env_file),
        "--compose-file", str(args.compose_file),
        "--cutover-plan", str(args.cutover_plan),
    ]
    code, result = run_json(command)
    if (
        code != 0
        or result.get("status") != "SERVICE_CUTOVER_PLAN_VERIFIED"
        or result.get("serviceCutoverPlanVersion") != 2
        or result.get("liveBaselineRequired") is not True
        or result.get("serviceCutoverExecutionAllowed") is not False
        or result.get("serviceCutoverExecuted") is not False
        or result.get("liveRuntimeAttested") is not False
        or result.get("activationExecuted") is not False
    ):
        fail("LIVE_BASELINE_CUTOVER_PLAN_NOT_VERIFIED", f"cutover plan verification failed: {result.get('blocker')}")
    raw = read_file(args.cutover_plan, "SERVICE_CUTOVER_PLAN", private=True)
    envelope = json.loads(raw)
    if not isinstance(envelope, dict) or not isinstance(envelope.get("record"), dict):
        fail("LIVE_BASELINE_CUTOVER_PLAN_INVALID", "cutover plan record is missing")
    record = envelope["record"]
    if record.get("cutoverPlanFingerprint") != result.get("cutoverPlanFingerprint"):
        fail("LIVE_BASELINE_CUTOVER_PLAN_MISMATCH", "verified plan fingerprint differs from plan record")
    return result, record


def render_compose_project(compose_file: Path, env_file: Path) -> str:
    proc = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(compose_file), "config", "--format", "json"],
        check=False,
        capture_output=True,
    )
    if proc.returncode != 0:
        fail("LIVE_BASELINE_COMPOSE_RENDER_FAILED", proc.stderr[:300])
    try:
        rendered = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("LIVE_BASELINE_COMPOSE_RENDER_INVALID: rendered compose is not JSON") from exc
    project = rendered.get("name") if isinstance(rendered, dict) else None
    if not isinstance(project, str) or not project:
        fail("LIVE_BASELINE_COMPOSE_PROJECT_INVALID", "rendered compose project name is missing")
    return project


def inspect_object(path: Path, service: str) -> dict[str, Any]:
    raw = read_file(path, f"LIVE_BASELINE_{service.upper().replace('-', '_')}_INSPECT")
    parsed = json.loads(raw)
    if not isinstance(parsed, list) or len(parsed) != 1 or not isinstance(parsed[0], dict):
        fail("LIVE_BASELINE_INSPECT_CARDINALITY_INVALID", f"{service} inspect evidence must contain exactly one container")
    return parsed[0]


def env_map(container: dict[str, Any]) -> dict[str, str]:
    raw = container.get("Config", {}).get("Env", [])
    if not isinstance(raw, list):
        fail("LIVE_BASELINE_ENV_INVALID", "container environment is invalid")
    result: dict[str, str] = {}
    for item in raw:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            result[key] = value
    return result


def privacy_env_fingerprint(environment: dict[str, str]) -> str:
    technical = {key: environment[key] for key in PRIVACY_KEYS if key in environment}
    return sha256_bytes(canonical_json(technical).encode())


def health_status(container: dict[str, Any]) -> str:
    state = container.get("State")
    if not isinstance(state, dict):
        fail("LIVE_BASELINE_STATE_INVALID", "container state is missing")
    health = state.get("Health")
    if health is None:
        return "NO_HEALTHCHECK"
    if not isinstance(health, dict) or not isinstance(health.get("Status"), str):
        fail("LIVE_BASELINE_HEALTH_INVALID", "container health is invalid")
    return health["Status"]


def named_mounts(container: dict[str, Any], service: str) -> dict[str, str]:
    mounts = container.get("Mounts")
    if not isinstance(mounts, list):
        fail("LIVE_BASELINE_MOUNTS_INVALID", f"{service} mounts are invalid")
    expected = MOUNT_TARGETS[service]
    result: dict[str, str] = {}
    for target, role in expected.items():
        matches = [
            item for item in mounts
            if isinstance(item, dict)
            and item.get("Type") == "volume"
            and item.get("Destination") == target
            and item.get("RW") is True
            and isinstance(item.get("Name"), str)
        ]
        if len(matches) != 1:
            fail("LIVE_BASELINE_MOUNT_CARDINALITY_INVALID", f"{service}:{target} must have exactly one RW named volume")
        name = matches[0]["Name"]
        if not VOLUME_NAME.fullmatch(name):
            fail("LIVE_BASELINE_VOLUME_NAME_INVALID", f"{service}:{target} volume name is unsafe")
        result[role] = name
    return result


def summarize_container(container: dict[str, Any], service: str, project: str) -> dict[str, Any]:
    container_id = container.get("Id")
    image_id = container.get("Image")
    config = container.get("Config")
    state = container.get("State")
    if not isinstance(container_id, str) or not CONTAINER_ID.fullmatch(container_id):
        fail("LIVE_BASELINE_CONTAINER_ID_INVALID", f"{service} container ID is invalid")
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        fail("LIVE_BASELINE_IMAGE_ID_INVALID", f"{service} image ID is invalid")
    if not isinstance(config, dict) or not isinstance(state, dict):
        fail("LIVE_BASELINE_CONTAINER_INVALID", f"{service} config/state is invalid")
    labels = config.get("Labels")
    if not isinstance(labels, dict):
        fail("LIVE_BASELINE_LABELS_INVALID", f"{service} labels are invalid")
    if labels.get("com.docker.compose.service") != service or labels.get("com.docker.compose.project") != project:
        fail("LIVE_BASELINE_COMPOSE_IDENTITY_MISMATCH", f"{service} container is not the expected Compose service/project")
    if state.get("Status") != "running" or state.get("Running") is not True:
        fail("LIVE_BASELINE_SERVICE_NOT_RUNNING", f"{service} must be running")
    health = health_status(container)
    if service in ("app", "libsql") and health != "healthy":
        fail("LIVE_BASELINE_SERVICE_NOT_HEALTHY", f"{service} must be healthy")
    image_ref = config.get("Image")
    if not isinstance(image_ref, str) or not image_ref:
        fail("LIVE_BASELINE_IMAGE_REFERENCE_INVALID", f"{service} image reference is missing")
    environment = env_map(container)
    if service in RECREATE and environment.get("PRIVACY_BACKUP_STATE") != "DISABLED":
        fail("LIVE_BASELINE_PRIVACY_STATE_NOT_DISABLED", f"{service} live backup state must be DISABLED before cutover")
    return {
        "service": service,
        "containerId": container_id,
        "imageId": image_id,
        "imageReference": image_ref,
        "status": "running",
        "healthStatus": health,
        "privacyBackupState": environment.get("PRIVACY_BACKUP_STATE") if service in RECREATE else None,
        "privacyEnvironmentFingerprint": privacy_env_fingerprint(environment) if service in RECREATE else None,
        "namedVolumes": named_mounts(container, service),
    }


def validate_cross_service_mounts(summaries: dict[str, dict[str, Any]]) -> None:
    app = summaries["app"]["namedVolumes"]
    cleanup = summaries["export-cleanup"]["namedVolumes"]
    if cleanup.get("tenantExports") != app.get("tenantExports") or cleanup.get("dataSubjectDelivery") != app.get("dataSubjectDelivery"):
        fail("LIVE_BASELINE_BACKGROUND_VOLUME_MISMATCH", "export-cleanup volumes do not match app volumes")
    role_names = {
        summaries["libsql"]["namedVolumes"].get("libsql"),
        app.get("reports"),
        app.get("tenantExports"),
        app.get("dataSubjectDelivery"),
    }
    if None in role_names or len(role_names) != 4:
        fail("LIVE_BASELINE_DATA_VOLUME_SET_INVALID", "application data volume roles must be distinct")
    caddy = summaries["caddy"]["namedVolumes"]
    if len({caddy.get("caddyData"), caddy.get("caddyConfig")}) != 2 or None in {caddy.get("caddyData"), caddy.get("caddyConfig")}:
        fail("LIVE_BASELINE_CADDY_VOLUME_SET_INVALID", "caddy data/config volumes must be distinct")


def actual_state(args: argparse.Namespace, project: str) -> dict[str, Any]:
    sources = {
        "app": args.app_inspect,
        "export-cleanup": args.export_cleanup_inspect,
        "retention-scan": args.retention_scan_inspect,
        "libsql": args.libsql_inspect,
        "caddy": args.caddy_inspect,
    }
    summaries = {service: summarize_container(inspect_object(path, service), service, project) for service, path in sources.items()}
    validate_cross_service_mounts(summaries)
    return {
        "composeProject": project,
        "containers": [summaries[name] for name in (*RECREATE, *PRESERVE)],
        "preservedContainerIds": {name: summaries[name]["containerId"] for name in PRESERVE},
        "dataVolumes": {
            "libsql": summaries["libsql"]["namedVolumes"]["libsql"],
            "reports": summaries["app"]["namedVolumes"]["reports"],
            "tenantExports": summaries["app"]["namedVolumes"]["tenantExports"],
            "dataSubjectDelivery": summaries["app"]["namedVolumes"]["dataSubjectDelivery"],
        },
        "caddyVolumes": summaries["caddy"]["namedVolumes"],
    }


def canonical_timestamp(value: str) -> None:
    if not CANONICAL_UTC.fullmatch(value):
        fail("LIVE_BASELINE_TIMESTAMP_INVALID", "recordedAt must be canonical UTC")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("LIVE_BASELINE_TIMESTAMP_INVALID: recordedAt is invalid") from exc


def sign(record: dict[str, Any], key: bytes) -> str:
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode(), hashlib.sha256).hexdigest()


def build_record(args: argparse.Namespace, plan_result: dict[str, Any], plan_record: dict[str, Any], state: dict[str, Any], recorded_at: str) -> dict[str, Any]:
    canonical_timestamp(recorded_at)
    cutover_id = plan_record.get("cutoverId")
    if not isinstance(cutover_id, str) or not CUTOVER_ID.fullmatch(cutover_id):
        fail("LIVE_BASELINE_CUTOVER_ID_INVALID", "cutover ID is invalid")
    record: dict[str, Any] = {
        "liveBaselineVersion": BASELINE_VERSION,
        "phase": "LIVE_BASELINE",
        "recordedAt": recorded_at,
        "cutoverId": cutover_id,
        "activationId": plan_record.get("activationId"),
        "executionId": plan_record.get("executionId"),
        "cutoverPlanFingerprint": plan_result.get("cutoverPlanFingerprint"),
        "cutoverPlanFileSha256": sha256_bytes(read_file(args.cutover_plan, "SERVICE_CUTOVER_PLAN", private=True)),
        "targetHandoffFingerprint": plan_result.get("targetHandoffFingerprint"),
        "targetEnvFingerprint": plan_record.get("targetEnvFingerprint"),
        "renderedComposeSha256": plan_result.get("renderedComposeSha256"),
        **state,
        "recreateServices": list(RECREATE),
        "preserveServices": list(PRESERVE),
        "livePreCutoverBackupState": "DISABLED",
        "preserveIdentityRequired": True,
        "liveBaselineRequiredBeforeMutation": True,
        "serviceCutoverExecutionAllowed": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }
    for field in ("cutoverPlanFingerprint", "cutoverPlanFileSha256", "targetHandoffFingerprint", "targetEnvFingerprint", "renderedComposeSha256"):
        if not isinstance(record.get(field), str) or not SHA256.fullmatch(record[field]):
            fail("LIVE_BASELINE_PLAN_BINDING_INVALID", f"{field} is invalid")
    record["liveBaselineFingerprint"] = sha256_bytes(canonical_json(record).encode())
    return record


def validate_record(record: dict[str, Any], expected: dict[str, Any]) -> None:
    if record.get("liveBaselineVersion") != 1 or record.get("phase") != "LIVE_BASELINE":
        fail("LIVE_BASELINE_VERSION_INVALID", "baseline version or phase is invalid")
    canonical_timestamp(str(record.get("recordedAt", "")))
    for field, value in expected.items():
        if field == "recordedAt":
            continue
        if record.get(field) != value:
            fail("LIVE_BASELINE_STATE_DRIFT", f"baseline differs from current {field}")
    if record.get("serviceCutoverExecutionAllowed") is not True or record.get("serviceCutoverExecuted") is not False or record.get("liveRuntimeAttested") is not False or record.get("activationExecuted") is not False:
        fail("LIVE_BASELINE_BOUNDARY_INVALID", "baseline mutation/runtime boundary is invalid")
    fingerprint = record.get("liveBaselineFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("LIVE_BASELINE_FINGERPRINT_INVALID", "baseline fingerprint is invalid")
    body = dict(record)
    body.pop("liveBaselineFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode())):
        fail("LIVE_BASELINE_FINGERPRINT_MISMATCH", "baseline fingerprint does not match")


def safe_output_dir(root: Path, cutover_id: str) -> Path:
    if not root.is_absolute():
        fail("LIVE_BASELINE_OUTPUT_NOT_ABSOLUTE", "output root must be absolute")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        fail("LIVE_BASELINE_OUTPUT_UNSAFE", "output root must be a non-symlink directory")
    os.chmod(root, 0o700)
    directory = root / cutover_id
    directory.mkdir(exist_ok=True, mode=0o700)
    if directory.is_symlink() or not directory.is_dir():
        fail("LIVE_BASELINE_OUTPUT_UNSAFE", "cutover baseline directory must be a non-symlink directory")
    os.chmod(directory, 0o700)
    return directory


def persist(path: Path, envelope: dict[str, Any]) -> bool:
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        fd = -1
        os.chmod(path, 0o600)
        parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        return True
    finally:
        if fd >= 0:
            os.close(fd)


def read_baseline(path: Path, key: bytes, expected: dict[str, Any]) -> dict[str, Any]:
    raw = read_file(path, "LIVE_BASELINE", private=True)
    envelope = json.loads(raw)
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("LIVE_BASELINE_INVALID", "baseline envelope is invalid")
    record = envelope["record"]
    validate_record(record, expected)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature) or not hmac.compare_digest(signature, sign(record, key)):
        fail("LIVE_BASELINE_SIGNATURE_MISMATCH", "baseline HMAC does not match")
    return envelope


def add_common(parser: argparse.ArgumentParser) -> None:
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
    parser.add_argument("--app-inspect", required=True, type=Path)
    parser.add_argument("--export-cleanup-inspect", required=True, type=Path)
    parser.add_argument("--retention-scan-inspect", required=True, type=Path)
    parser.add_argument("--libsql-inspect", required=True, type=Path)
    parser.add_argument("--caddy-inspect", required=True, type=Path)


def context(args: argparse.Namespace) -> tuple[bytes, dict[str, Any], dict[str, Any], dict[str, Any]]:
    key = read_key(args.key_file)
    plan_result, plan_record = verify_cutover_plan(args)
    project = render_compose_project(args.compose_file, args.env_file)
    state = actual_state(args, project)
    expected = build_record(args, plan_result, plan_record, state, args.recorded_at or "2000-01-01T00:00:00.000Z")
    return key, plan_result, plan_record, expected


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    key = read_key(args.key_file)
    plan_result, plan_record = verify_cutover_plan(args)
    project = render_compose_project(args.compose_file, args.env_file)
    state = actual_state(args, project)
    recorded_at = args.recorded_at
    if not recorded_at:
        fail("LIVE_BASELINE_TIMESTAMP_REQUIRED", "prepare requires explicit --recorded-at for deterministic evidence")
    record = build_record(args, plan_result, plan_record, state, recorded_at)
    directory = safe_output_dir(args.output_root, record["cutoverId"])
    path = directory / BASELINE_FILE
    if path.exists():
        expected = dict(record)
        expected.pop("recordedAt")
        expected.pop("liveBaselineFingerprint")
        envelope = read_baseline(path, key, expected)
        record = envelope["record"]
        created = False
    else:
        envelope = {"envelopeVersion": 1, "record": record, "signature": sign(record, key)}
        created = persist(path, envelope)
        if not created:
            expected = dict(record)
            expected.pop("recordedAt")
            expected.pop("liveBaselineFingerprint")
            envelope = read_baseline(path, key, expected)
            record = envelope["record"]
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
        "status": "LIVE_BASELINE_READY",
        "cutoverId": record["cutoverId"],
        "liveBaselineFingerprint": record["liveBaselineFingerprint"],
        "baselinePath": str(path),
        "baselineCreated": created,
        "baselineReused": not created,
        "serviceCutoverExecutionAllowed": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }


def check(args: argparse.Namespace) -> dict[str, Any]:
    key = read_key(args.key_file)
    plan_result, plan_record = verify_cutover_plan(args)
    project = render_compose_project(args.compose_file, args.env_file)
    state = actual_state(args, project)
    expected = build_record(args, plan_result, plan_record, state, "2000-01-01T00:00:00.000Z")
    expected.pop("recordedAt")
    expected.pop("liveBaselineFingerprint")
    envelope = read_baseline(args.baseline, key, expected)
    record = envelope["record"]
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE_CHECK",
        "status": "LIVE_BASELINE_VERIFIED",
        "cutoverId": record["cutoverId"],
        "liveBaselineFingerprint": record["liveBaselineFingerprint"],
        "baselineFileSha256": sha256_bytes(read_file(args.baseline, "LIVE_BASELINE", private=True)),
        "serviceCutoverExecutionAllowed": True,
        "preserveIdentityRequired": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    prepare_parser = sub.add_parser("prepare")
    add_common(prepare_parser)
    prepare_parser.add_argument("--output-root", required=True, type=Path)
    prepare_parser.add_argument("--recorded-at", required=True)
    check_parser = sub.add_parser("check")
    add_common(check_parser)
    check_parser.add_argument("--baseline", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args) if args.command == "prepare" else check(args)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
