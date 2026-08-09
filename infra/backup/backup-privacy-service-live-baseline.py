#!/usr/bin/env python3
"""Prepare and verify a signed read-only live baseline before backup-privacy service cutover."""
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
from pathlib import Path
from typing import Any

BASELINE_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-service-live-baseline:v1\n"
BASELINE_FILE = "service-live-baseline.json"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CUTOVER_ID = re.compile(r"^cutover-[0-9a-f]{32}$")
BASELINE_ID = re.compile(r"^baseline-[0-9a-f]{32}$")
DOCKER_ID = re.compile(r"^[0-9a-f]{12,64}$")
DOCKER_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
DOCKER_VOLUME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
COMPOSE_PROJECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")

MUTABLE_SERVICES = ("app", "export-cleanup", "retention-scan")
PRESERVED_SERVICES = ("libsql", "caddy")
ALL_SERVICES = MUTABLE_SERVICES + PRESERVED_SERVICES
DATA_MOUNTS = (
    ("LIBSQL", "libsql", "/var/lib/sqld"),
    ("REPORTS", "app", "/var/lib/masters/reports"),
    ("TENANT_EXPORTS", "app", "/var/lib/masters/exports"),
    ("DATA_SUBJECT_DELIVERY", "app", "/var/lib/masters/data-subject-delivery-packages"),
)


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
    raw = read_file(path, "SERVICE_LIVE_BASELINE_KEY", private=True)
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("SERVICE_LIVE_BASELINE_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("SERVICE_LIVE_BASELINE_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def run_json(command: list[str]) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(command, check=False, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_DEPENDENCY_OUTPUT_INVALID: dependency did not return JSON") from exc
    if not isinstance(result, dict):
        fail("SERVICE_LIVE_BASELINE_DEPENDENCY_OUTPUT_INVALID", "dependency output must be an object")
    return proc.returncode, result


def verify_cutover_plan(args: argparse.Namespace) -> dict[str, Any]:
    checker = args.cutover_plan_checker
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("SERVICE_CUTOVER_PLAN_CHECKER_UNSAFE", "v2 cutover-plan checker is unsafe")
    command = [
        sys.executable, str(checker),
        "--handoff-checker", str(args.handoff_checker),
        "--activation-plan", str(args.activation_plan),
        "--pending", str(args.pending),
        "--handoff", str(args.handoff),
        "--key-file", str(args.key_file),
        "--env-file", str(args.env_file),
        "--compose-file", str(args.compose_file),
        "--cutover-plan", str(args.cutover_plan),
    ]
    if args.target_config_checker is not None:
        command.extend(["--target-config-checker", str(args.target_config_checker)])
    code, result = run_json(command)
    if (
        code != 0
        or result.get("status") != "SERVICE_CUTOVER_PLAN_VERIFIED"
        or result.get("serviceCutoverPlanVersion") != 2
        or result.get("authorizationSource") != "TARGET_HANDOFF_VERIFIED"
        or result.get("serviceCutoverExecutionAllowed") is not True
        or result.get("liveBaselineRequiredBeforeMutation") is not True
        or result.get("serviceCutoverExecuted") is not False
        or result.get("liveRuntimeAttested") is not False
        or result.get("activationExecuted") is not False
    ):
        fail("SERVICE_CUTOVER_PLAN_NOT_VERIFIED", f"v2 cutover plan verification failed: {result.get('blocker')}")
    cutover_id = result.get("cutoverId")
    if not isinstance(cutover_id, str) or not CUTOVER_ID.fullmatch(cutover_id):
        fail("SERVICE_CUTOVER_ID_INVALID", "verified cutover ID is invalid")
    fingerprint = result.get("cutoverPlanFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("SERVICE_CUTOVER_PLAN_FINGERPRINT_INVALID", "verified cutover plan fingerprint is invalid")
    return result


def read_inspect(path: Path, expected_service: str) -> dict[str, Any]:
    raw = read_file(path, "SERVICE_LIVE_BASELINE_INSPECT")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"SERVICE_LIVE_BASELINE_INSPECT_INVALID: invalid inspect JSON for {expected_service}") from exc
    if not isinstance(parsed, list) or len(parsed) != 1 or not isinstance(parsed[0], dict):
        fail("SERVICE_LIVE_BASELINE_INSPECT_INVALID", f"inspect for {expected_service} must contain exactly one container")
    container = parsed[0]
    container_id = container.get("Id")
    image_id = container.get("Image")
    config = container.get("Config")
    state = container.get("State")
    mounts = container.get("Mounts")
    if not isinstance(container_id, str) or not DOCKER_ID.fullmatch(container_id):
        fail("SERVICE_LIVE_BASELINE_CONTAINER_ID_INVALID", f"container ID for {expected_service} is invalid")
    if not isinstance(image_id, str) or not DOCKER_IMAGE_ID.fullmatch(image_id):
        fail("SERVICE_LIVE_BASELINE_IMAGE_ID_INVALID", f"image ID for {expected_service} is invalid")
    if not isinstance(config, dict) or not isinstance(state, dict) or not isinstance(mounts, list):
        fail("SERVICE_LIVE_BASELINE_INSPECT_INVALID", f"container fields for {expected_service} are invalid")
    labels = config.get("Labels")
    if not isinstance(labels, dict) or labels.get("com.docker.compose.service") != expected_service:
        fail("SERVICE_LIVE_BASELINE_SERVICE_IDENTITY_INVALID", f"container is not Compose service {expected_service}")
    project = labels.get("com.docker.compose.project")
    if not isinstance(project, str) or not COMPOSE_PROJECT.fullmatch(project):
        fail("SERVICE_LIVE_BASELINE_PROJECT_INVALID", f"Compose project for {expected_service} is invalid")
    image_ref = config.get("Image")
    if not isinstance(image_ref, str) or not image_ref:
        fail("SERVICE_LIVE_BASELINE_IMAGE_REF_INVALID", f"image reference for {expected_service} is invalid")
    if state.get("Status") != "running":
        fail("SERVICE_LIVE_BASELINE_SERVICE_NOT_RUNNING", f"service {expected_service} is not running")
    health = state.get("Health")
    health_status = health.get("Status") if isinstance(health, dict) else None
    if expected_service in ("app", "libsql") and health_status != "healthy":
        fail("SERVICE_LIVE_BASELINE_SERVICE_NOT_HEALTHY", f"service {expected_service} is not healthy")
    env: dict[str, str] = {}
    env_raw = config.get("Env")
    if isinstance(env_raw, list):
        for item in env_raw:
            if not isinstance(item, str) or "=" not in item:
                continue
            key, value = item.split("=", 1)
            if key.startswith("PRIVACY_BACKUP_"):
                if key in env:
                    fail("SERVICE_LIVE_BASELINE_PRIVACY_ENV_DUPLICATE", f"duplicate {key} in {expected_service}")
                env[key] = value
    return {
        "service": expected_service,
        "containerId": container_id,
        "imageId": image_id,
        "imageRef": image_ref,
        "project": project,
        "status": "running",
        "health": health_status,
        "privacyBackupEnvironment": env,
        "mounts": mounts,
    }


def volume_mount(container: dict[str, Any], target: str, label: str) -> dict[str, Any]:
    matches = [
        item for item in container["mounts"]
        if isinstance(item, dict)
        and item.get("Type") == "volume"
        and item.get("Destination") == target
        and isinstance(item.get("Name"), str)
    ]
    if len(matches) != 1:
        fail("SERVICE_LIVE_BASELINE_VOLUME_MOUNT_INVALID", f"{label} must resolve exactly one named volume")
    match = matches[0]
    name = match["Name"]
    if not DOCKER_VOLUME.fullmatch(name):
        fail("SERVICE_LIVE_BASELINE_VOLUME_NAME_INVALID", f"{label} has unsafe volume name")
    if match.get("RW") is not True:
        fail("SERVICE_LIVE_BASELINE_VOLUME_READONLY", f"{label} is unexpectedly read-only")
    return {"name": name, "destination": target, "readWrite": True}


def live_summary(inspects: dict[str, dict[str, Any]]) -> dict[str, Any]:
    projects = {item["project"] for item in inspects.values()}
    if len(projects) != 1:
        fail("SERVICE_LIVE_BASELINE_PROJECT_MISMATCH", "all containers must belong to the same Compose project")
    ids = [item["containerId"] for item in inspects.values()]
    if len(set(ids)) != len(ids):
        fail("SERVICE_LIVE_BASELINE_CONTAINER_ID_CONFLICT", "container IDs must be distinct")
    for service in MUTABLE_SERVICES:
        env = inspects[service]["privacyBackupEnvironment"]
        if env.get("PRIVACY_BACKUP_STATE") != "DISABLED":
            fail("SERVICE_LIVE_BASELINE_MUTABLE_NOT_DISABLED", f"{service} is not live with PRIVACY_BACKUP_STATE=DISABLED")
        for key in (
            "PRIVACY_BACKUP_POLICY_VERSION",
            "PRIVACY_BACKUP_ENCRYPTED_AT_REST",
            "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED",
            "PRIVACY_BACKUP_RESTORE_RECONCILIATION",
        ):
            if key in env:
                fail("SERVICE_LIVE_BASELINE_MUTABLE_TARGET_LEAK", f"{service} already carries target-only variable {key}")
    data_volumes: list[dict[str, Any]] = []
    for role, service, target in DATA_MOUNTS:
        mount = volume_mount(inspects[service], target, f"{service}:{target}")
        data_volumes.append({"role": role, "service": service, **mount})
    names = [item["name"] for item in data_volumes]
    if len(set(names)) != len(names):
        fail("SERVICE_LIVE_BASELINE_DATA_VOLUME_CONFLICT", "four application data roles must use distinct named volumes")
    export_mount = volume_mount(inspects["export-cleanup"], "/var/lib/masters/exports", "export-cleanup:exports")
    delivery_mount = volume_mount(inspects["export-cleanup"], "/var/lib/masters/data-subject-delivery-packages", "export-cleanup:data-subject-delivery")
    role_map = {item["role"]: item["name"] for item in data_volumes}
    if export_mount["name"] != role_map["TENANT_EXPORTS"] or delivery_mount["name"] != role_map["DATA_SUBJECT_DELIVERY"]:
        fail("SERVICE_LIVE_BASELINE_SHARED_VOLUME_MISMATCH", "export-cleanup does not share the active export/delivery volumes with app")
    return {
        "project": next(iter(projects)),
        "mutableServices": [
            {key: value for key, value in inspects[service].items() if key != "mounts"}
            for service in MUTABLE_SERVICES
        ],
        "preservedServices": [
            {key: value for key, value in inspects[service].items() if key not in ("mounts", "privacyBackupEnvironment")}
            for service in PRESERVED_SERVICES
        ],
        "dataVolumes": data_volumes,
    }


def live_fingerprint(summary: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(summary).encode("utf-8"))


def expected_baseline_id(cutover_plan_fp: str, live_fp: str) -> str:
    return "baseline-" + hashlib.sha256(canonical_json({
        "cutoverPlanFingerprint": cutover_plan_fp,
        "liveFingerprint": live_fp,
    }).encode("utf-8")).hexdigest()[:32]


def record_fingerprint(record: dict[str, Any]) -> str:
    body = dict(record)
    body.pop("baselineFingerprint", None)
    return sha256_bytes(canonical_json(body).encode("utf-8"))


def make_record(args: argparse.Namespace, plan_result: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    live_fp = live_fingerprint(summary)
    cutover_plan_file_sha = sha256_bytes(read_file(args.cutover_plan, "SERVICE_CUTOVER_PLAN", private=True))
    record: dict[str, Any] = {
        "serviceLiveBaselineVersion": BASELINE_VERSION,
        "phase": "PRE_MUTATION",
        "baselineId": expected_baseline_id(plan_result["cutoverPlanFingerprint"], live_fp),
        "cutoverId": plan_result["cutoverId"],
        "activationId": plan_result["activationId"],
        "cutoverPlanFingerprint": plan_result["cutoverPlanFingerprint"],
        "cutoverPlanPath": str(args.cutover_plan),
        "cutoverPlanFileSha256": cutover_plan_file_sha,
        "renderedComposeSha256": plan_result["renderedComposeSha256"],
        "liveFingerprint": live_fp,
        **summary,
        "baselineRequiredBeforeMutation": True,
        "allMutableServicesDisabled": True,
        "preservedContainerIdentityRequired": True,
        "activeDataVolumesBound": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }
    record["baselineFingerprint"] = record_fingerprint(record)
    return record


def validate_record(record: dict[str, Any], args: argparse.Namespace, plan_result: dict[str, Any], summary: dict[str, Any]) -> None:
    if record.get("serviceLiveBaselineVersion") != BASELINE_VERSION or record.get("phase") != "PRE_MUTATION":
        fail("SERVICE_LIVE_BASELINE_VERSION_INVALID", "baseline version or phase is invalid")
    baseline_id = record.get("baselineId")
    if not isinstance(baseline_id, str) or not BASELINE_ID.fullmatch(baseline_id):
        fail("SERVICE_LIVE_BASELINE_ID_INVALID", "baseline ID is invalid")
    if record.get("cutoverId") != plan_result["cutoverId"] or record.get("activationId") != plan_result["activationId"]:
        fail("SERVICE_LIVE_BASELINE_PLAN_BINDING_MISMATCH", "baseline IDs do not match v2 cutover plan")
    if record.get("cutoverPlanFingerprint") != plan_result["cutoverPlanFingerprint"]:
        fail("SERVICE_LIVE_BASELINE_PLAN_BINDING_MISMATCH", "baseline plan fingerprint differs from verified v2 plan")
    if record.get("cutoverPlanPath") != str(args.cutover_plan):
        fail("SERVICE_LIVE_BASELINE_PLAN_PATH_MISMATCH", "baseline plan path differs")
    if record.get("cutoverPlanFileSha256") != sha256_bytes(read_file(args.cutover_plan, "SERVICE_CUTOVER_PLAN", private=True)):
        fail("SERVICE_LIVE_BASELINE_PLAN_FILE_DRIFT", "v2 cutover plan file changed after baseline")
    if record.get("renderedComposeSha256") != plan_result["renderedComposeSha256"]:
        fail("SERVICE_LIVE_BASELINE_COMPOSE_BINDING_MISMATCH", "rendered Compose fingerprint differs from verified v2 plan")
    current_live_fp = live_fingerprint(summary)
    if record.get("liveFingerprint") != current_live_fp:
        fail("SERVICE_LIVE_BASELINE_LIVE_DRIFT", "current live container state differs from signed baseline")
    if record.get("baselineId") != expected_baseline_id(plan_result["cutoverPlanFingerprint"], current_live_fp):
        fail("SERVICE_LIVE_BASELINE_ID_MISMATCH", "baseline ID does not match immutable binding")
    for field in ("project", "mutableServices", "preservedServices", "dataVolumes"):
        if record.get(field) != summary[field]:
            fail("SERVICE_LIVE_BASELINE_LIVE_BINDING_MISMATCH", f"baseline field {field} differs from current live evidence")
    for field in (
        "baselineRequiredBeforeMutation",
        "allMutableServicesDisabled",
        "preservedContainerIdentityRequired",
        "activeDataVolumesBound",
    ):
        if record.get(field) is not True:
            fail("SERVICE_LIVE_BASELINE_POLICY_INVALID", f"{field} must be true")
    if record.get("serviceCutoverExecuted") is not False or record.get("liveRuntimeAttested") is not False or record.get("activationExecuted") is not False:
        fail("SERVICE_LIVE_BASELINE_BOUNDARY_INVALID", "baseline must remain strictly pre-mutation")
    fingerprint = record.get("baselineFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("SERVICE_LIVE_BASELINE_FINGERPRINT_INVALID", "baseline fingerprint is invalid")
    if not hmac.compare_digest(fingerprint, record_fingerprint(record)):
        fail("SERVICE_LIVE_BASELINE_FINGERPRINT_MISMATCH", "baseline fingerprint does not match record")


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def ensure_root(path: Path) -> None:
    if not path.is_absolute():
        fail("SERVICE_LIVE_BASELINE_OUTPUT_NOT_ABSOLUTE", "output root must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("SERVICE_LIVE_BASELINE_OUTPUT_UNSAFE", "output root must be a non-symlink directory")
    os.chmod(path, 0o700)


def baseline_path(root: Path, cutover_id: str, create: bool) -> Path:
    ensure_root(root)
    directory = root / cutover_id
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or not directory.is_dir():
            fail("SERVICE_LIVE_BASELINE_DIR_UNSAFE", "baseline directory is unsafe")
        os.chmod(directory, 0o700)
    elif directory.is_symlink() or not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) & 0o077:
        fail("SERVICE_LIVE_BASELINE_DIR_UNSAFE", "baseline directory is missing or unsafe")
    return directory / BASELINE_FILE


def read_baseline(path: Path, key: bytes, args: argparse.Namespace, plan_result: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    raw = read_file(path, "SERVICE_LIVE_BASELINE", private=True)
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_LIVE_BASELINE_INVALID: baseline is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
        fail("SERVICE_LIVE_BASELINE_INVALID", "baseline envelope is invalid")
    record = envelope["record"]
    validate_record(record, args, plan_result, summary)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("SERVICE_LIVE_BASELINE_SIGNATURE_INVALID", "baseline signature is invalid")
    if not hmac.compare_digest(signature, sign_record(record, key)):
        fail("SERVICE_LIVE_BASELINE_SIGNATURE_MISMATCH", "baseline HMAC does not match")
    return envelope


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
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    return True


def load_summary(args: argparse.Namespace) -> dict[str, Any]:
    paths = {
        "app": args.app_inspect,
        "export-cleanup": args.export_inspect,
        "retention-scan": args.retention_inspect,
        "libsql": args.libsql_inspect,
        "caddy": args.caddy_inspect,
    }
    return live_summary({service: read_inspect(paths[service], service) for service in ALL_SERVICES})


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    key = read_key(args.key_file)
    plan_result = verify_cutover_plan(args)
    summary = load_summary(args)
    path = baseline_path(args.output_root, plan_result["cutoverId"], create=True)
    record = make_record(args, plan_result, summary)
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(record, key)}
    created = persist(path, envelope)
    if not created:
        existing = read_baseline(path, key, args, plan_result, summary)
        if existing != envelope:
            fail("SERVICE_LIVE_BASELINE_CONFLICT", "existing baseline differs from deterministic current baseline")
        envelope = existing
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
        "status": "SERVICE_LIVE_BASELINE_READY",
        "baselineId": envelope["record"]["baselineId"],
        "cutoverId": envelope["record"]["cutoverId"],
        "activationId": envelope["record"]["activationId"],
        "baselineFingerprint": envelope["record"]["baselineFingerprint"],
        "liveFingerprint": envelope["record"]["liveFingerprint"],
        "baselinePath": str(path),
        "baselineCreated": created,
        "baselineReused": not created,
        "serviceCutoverMutationAllowed": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }


def check(args: argparse.Namespace) -> dict[str, Any]:
    key = read_key(args.key_file)
    plan_result = verify_cutover_plan(args)
    summary = load_summary(args)
    envelope = read_baseline(args.baseline, key, args, plan_result, summary)
    if args.baseline.parent.name != plan_result["cutoverId"]:
        fail("SERVICE_LIVE_BASELINE_PATH_BINDING_MISMATCH", "baseline parent does not match cutover ID")
    return {
        "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE_VERIFICATION",
        "status": "SERVICE_LIVE_BASELINE_VERIFIED",
        "baselineId": envelope["record"]["baselineId"],
        "cutoverId": envelope["record"]["cutoverId"],
        "activationId": envelope["record"]["activationId"],
        "baselineFingerprint": envelope["record"]["baselineFingerprint"],
        "liveFingerprint": envelope["record"]["liveFingerprint"],
        "serviceCutoverMutationAllowed": True,
        "serviceCutoverExecuted": False,
        "liveRuntimeAttested": False,
        "activationExecuted": False,
    }


def add_common(parser: argparse.ArgumentParser) -> None:
    root = Path(__file__).resolve().parents[2]
    parser.add_argument("--cutover-plan-checker", type=Path, default=root / "infra/backup/check-backup-privacy-service-cutover-plan-v2.py")
    parser.add_argument("--handoff-checker", type=Path, default=root / "infra/backup/check-backup-privacy-target-handoff.py")
    parser.add_argument("--target-config-checker", type=Path)
    parser.add_argument("--activation-plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--handoff", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--cutover-plan", required=True, type=Path)
    parser.add_argument("--app-inspect", required=True, type=Path)
    parser.add_argument("--export-inspect", required=True, type=Path)
    parser.add_argument("--retention-inspect", required=True, type=Path)
    parser.add_argument("--libsql-inspect", required=True, type=Path)
    parser.add_argument("--caddy-inspect", required=True, type=Path)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    prepare_parser = sub.add_parser("prepare")
    add_common(prepare_parser)
    prepare_parser.add_argument("--output-root", required=True, type=Path)
    check_parser = sub.add_parser("check")
    add_common(check_parser)
    check_parser.add_argument("--baseline", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args) if args.command == "prepare" else check(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_LIVE_BASELINE",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "serviceCutoverMutationAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
