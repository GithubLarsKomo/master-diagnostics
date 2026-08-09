#!/usr/bin/env python3
"""Prepare and assess signed pre-mutation evidence for backup-privacy live runtime cutover."""
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CUTOVER_VERSION = 1
ENVELOPE_VERSION = 1
SIGNING_DOMAIN = b"masters:backup-privacy-runtime-cutover:v1\n"
PENDING_FILE = "runtime-cutover-pending.json"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
CUTOVER_ID = re.compile(r"^cutover-[0-9a-f]{32}$")
CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
DOCKER_ID = re.compile(r"^[0-9a-f]{12,64}$")
PROJECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")

MUTABLE_SERVICES = ("app", "export-cleanup", "retention-scan")
PRESERVED_SERVICES = ("libsql", "caddy")
ALL_SERVICES = MUTABLE_SERVICES + PRESERVED_SERVICES
TARGET_ENV = {
    "PRIVACY_BACKUP_STATE": "ENABLED",
    "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_timestamp(value: str) -> None:
    if not CANONICAL_UTC.fullmatch(value):
        fail("RUNTIME_CUTOVER_TIMESTAMP_INVALID", "timestamp must use canonical UTC milliseconds")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("RUNTIME_CUTOVER_TIMESTAMP_INVALID: invalid timestamp") from exc


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("RUNTIME_CUTOVER_KEY_UNSAFE", "key must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("RUNTIME_CUTOVER_KEY_PERMISSIONS_UNSAFE", "key must not be group/world writable")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("RUNTIME_CUTOVER_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("RUNTIME_CUTOVER_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def run_completion_authenticator(args: argparse.Namespace) -> dict[str, Any]:
    checker = args.completion_checker
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("ACTIVATION_COMPLETION_CHECKER_UNSAFE", "completion checker must be an absolute regular non-symlink file")
    proc = subprocess.run([
        sys.executable,
        str(checker),
        "--plan", str(args.plan),
        "--pending", str(args.pending),
        "--key-file", str(args.key_file),
        "--env-file", str(args.env_file),
    ], check=False, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ACTIVATION_COMPLETION_CHECK_OUTPUT_INVALID: completion checker did not return JSON") from exc
    if proc.returncode != 0 or result.get("status") != "ACTIVATION_COMPLETION_AUTHENTICATED":
        fail("ACTIVATION_COMPLETION_NOT_AUTHENTICATED", f"completion evidence failed: {result.get('blocker')}")
    for field in ("planFingerprint", "completionMarkerSha256", "runtimeAttestationSha256"):
        if not isinstance(result.get(field), str) or not SHA256.fullmatch(result[field]):
            fail("ACTIVATION_COMPLETION_BINDING_INVALID", f"completion field {field} is invalid")
    if not isinstance(result.get("completionMarkerSignature"), str) or not HMAC_SHA256.fullmatch(result["completionMarkerSignature"]):
        fail("ACTIVATION_COMPLETION_BINDING_INVALID", "completion signature is invalid")
    activation_id = result.get("activationId")
    if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
        fail("ACTIVATION_COMPLETION_BINDING_INVALID", "activation ID is invalid")
    return result


def read_inspect(path: Path, expected_service: str) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("RUNTIME_CUTOVER_INSPECT_UNSAFE", f"inspect evidence for {expected_service} is unsafe")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"RUNTIME_CUTOVER_INSPECT_INVALID: invalid inspect JSON for {expected_service}") from exc
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        fail("RUNTIME_CUTOVER_INSPECT_INVALID", f"inspect evidence for {expected_service} must contain exactly one container")
    container = raw[0]
    container_id = container.get("Id")
    if not isinstance(container_id, str) or not DOCKER_ID.fullmatch(container_id):
        fail("RUNTIME_CUTOVER_CONTAINER_ID_INVALID", f"container ID for {expected_service} is invalid")
    config = container.get("Config")
    state = container.get("State")
    if not isinstance(config, dict) or not isinstance(state, dict):
        fail("RUNTIME_CUTOVER_INSPECT_INVALID", f"container config/state for {expected_service} is invalid")
    labels = config.get("Labels")
    if not isinstance(labels, dict) or labels.get("com.docker.compose.service") != expected_service:
        fail("RUNTIME_CUTOVER_SERVICE_IDENTITY_INVALID", f"container is not Compose service {expected_service}")
    project = labels.get("com.docker.compose.project")
    if not isinstance(project, str) or not PROJECT.fullmatch(project):
        fail("RUNTIME_CUTOVER_PROJECT_INVALID", f"Compose project for {expected_service} is invalid")
    status = state.get("Status")
    if status != "running":
        fail("RUNTIME_CUTOVER_SERVICE_NOT_RUNNING", f"service {expected_service} is not running")
    health_status = None
    health = state.get("Health")
    if isinstance(health, dict):
        health_status = health.get("Status")
    if expected_service in ("app", "libsql") and health_status != "healthy":
        fail("RUNTIME_CUTOVER_SERVICE_NOT_HEALTHY", f"service {expected_service} is not healthy")
    env_raw = config.get("Env")
    env_values: dict[str, str] = {}
    if isinstance(env_raw, list):
        for item in env_raw:
            if not isinstance(item, str) or "=" not in item:
                continue
            key, value = item.split("=", 1)
            if key in TARGET_ENV:
                if key in env_values:
                    fail("RUNTIME_CUTOVER_ENV_DUPLICATE", f"container {expected_service} has duplicate {key}")
                env_values[key] = value
    return {
        "service": expected_service,
        "containerId": container_id,
        "project": project,
        "status": status,
        "health": health_status,
        "privacyBackupState": env_values.get("PRIVACY_BACKUP_STATE"),
        "privacyBackupPolicyVersion": env_values.get("PRIVACY_BACKUP_POLICY_VERSION"),
        "privacyBackupEncryptedAtRest": env_values.get("PRIVACY_BACKUP_ENCRYPTED_AT_REST"),
        "privacyBackupBoundedRetentionConfigured": env_values.get("PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED"),
        "privacyBackupRestoreReconciliation": env_values.get("PRIVACY_BACKUP_RESTORE_RECONCILIATION"),
    }


def load_live(args: argparse.Namespace) -> dict[str, dict[str, Any]]:
    paths = {
        "app": args.app_inspect,
        "export-cleanup": args.export_inspect,
        "retention-scan": args.retention_inspect,
        "libsql": args.libsql_inspect,
        "caddy": args.caddy_inspect,
    }
    live = {service: read_inspect(paths[service], service) for service in ALL_SERVICES}
    projects = {item["project"] for item in live.values()}
    if len(projects) != 1:
        fail("RUNTIME_CUTOVER_PROJECT_MISMATCH", "all observed containers must belong to the same Compose project")
    ids = [item["containerId"] for item in live.values()]
    if len(set(ids)) != len(ids):
        fail("RUNTIME_CUTOVER_CONTAINER_ID_CONFLICT", "container IDs must be distinct")
    return live


def mutable_state(item: dict[str, Any]) -> str:
    backup_state = item.get("privacyBackupState")
    if backup_state == "DISABLED":
        return "DISABLED"
    if all((
        backup_state == "ENABLED",
        item.get("privacyBackupPolicyVersion") == "1.0.0",
        item.get("privacyBackupEncryptedAtRest") == "true",
        item.get("privacyBackupBoundedRetentionConfigured") == "true",
        item.get("privacyBackupRestoreReconciliation") == "true",
    )):
        return "ENABLED"
    return "UNKNOWN"


def live_summary(live: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        "project": live["app"]["project"],
        "mutableServices": [
            {
                "service": service,
                "containerId": live[service]["containerId"],
                "backupState": mutable_state(live[service]),
                "status": live[service]["status"],
                "health": live[service]["health"],
            }
            for service in MUTABLE_SERVICES
        ],
        "preservedServices": [
            {
                "service": service,
                "containerId": live[service]["containerId"],
                "status": live[service]["status"],
                "health": live[service]["health"],
            }
            for service in PRESERVED_SERVICES
        ],
    }


def live_fingerprint(summary: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(summary).encode("utf-8"))


def expected_cutover_id(completion: dict[str, Any], pre_live_fingerprint: str) -> str:
    identity = {
        "activationId": completion["activationId"],
        "executionId": completion["executionId"],
        "planFingerprint": completion["planFingerprint"],
        "completionMarkerSha256": completion["completionMarkerSha256"],
        "completionMarkerSignature": completion["completionMarkerSignature"],
        "preLiveFingerprint": pre_live_fingerprint,
    }
    return "cutover-" + hashlib.sha256(canonical_json(identity).encode("utf-8")).hexdigest()[:32]


def make_record(completion: dict[str, Any], summary: dict[str, Any], started_at: str) -> dict[str, Any]:
    validate_timestamp(started_at)
    pre_fp = live_fingerprint(summary)
    states = [item["backupState"] for item in summary["mutableServices"]]
    if states != ["DISABLED", "DISABLED", "DISABLED"]:
        fail("RUNTIME_CUTOVER_PRESTATE_INVALID", "all mutable services must be live with backup state DISABLED before journal creation")
    record = {
        "runtimeCutoverVersion": CUTOVER_VERSION,
        "phase": "PENDING",
        "cutoverId": expected_cutover_id(completion, pre_fp),
        "startedAt": started_at,
        "activationId": completion["activationId"],
        "executionId": completion["executionId"],
        "executionFingerprint": completion["executionFingerprint"],
        "planFingerprint": completion["planFingerprint"],
        "completionMarkerSha256": completion["completionMarkerSha256"],
        "completionMarkerSignature": completion["completionMarkerSignature"],
        "fileRuntimeAttestationSha256": completion["runtimeAttestationSha256"],
        "envFilePath": completion["envFilePath"],
        "currentEnvFingerprint": completion["currentEnvFingerprint"],
        "targetEnvFingerprint": completion["targetEnvFingerprint"],
        "preLiveFingerprint": pre_fp,
        "project": summary["project"],
        "mutableServices": summary["mutableServices"],
        "preservedServices": summary["preservedServices"],
        "recreateServices": list(MUTABLE_SERVICES),
        "targetBackupState": "ENABLED",
        "rollbackBackupState": "DISABLED",
        "rollbackPolicy": "RESTORE_PLAN_V2_ENV_AND_RECREATE_MUTABLE_SERVICES",
        "libsqlPolicy": "PRESERVE_CONTAINER_ID",
        "caddyPolicy": "PRESERVE_CONTAINER_ID",
        "cutoverJournalRequiredBeforeMutation": True,
        "runtimeMutationStarted": False,
        "liveRuntimeChanged": False,
        "operationalActivationCompleted": False,
    }
    record["journalFingerprint"] = sha256_bytes(canonical_json(record).encode("utf-8"))
    return record


def validate_record(record: dict[str, Any], completion: dict[str, Any]) -> None:
    if record.get("runtimeCutoverVersion") != CUTOVER_VERSION or record.get("phase") != "PENDING":
        fail("RUNTIME_CUTOVER_JOURNAL_VERSION_INVALID", "journal version or phase is invalid")
    cutover_id = record.get("cutoverId")
    if not isinstance(cutover_id, str) or not CUTOVER_ID.fullmatch(cutover_id):
        fail("RUNTIME_CUTOVER_ID_INVALID", "cutover ID is invalid")
    started_at = record.get("startedAt")
    if not isinstance(started_at, str):
        fail("RUNTIME_CUTOVER_TIMESTAMP_INVALID", "startedAt is missing")
    validate_timestamp(started_at)
    for field in (
        "activationId", "executionId", "executionFingerprint", "planFingerprint",
        "completionMarkerSha256", "completionMarkerSignature", "fileRuntimeAttestationSha256",
        "envFilePath", "currentEnvFingerprint", "targetEnvFingerprint",
    ):
        if record.get(field) != completion.get(field):
            fail("RUNTIME_CUTOVER_COMPLETION_BINDING_MISMATCH", f"journal field {field} does not match completed file activation")
    pre_fp = record.get("preLiveFingerprint")
    if not isinstance(pre_fp, str) or not SHA256.fullmatch(pre_fp):
        fail("RUNTIME_CUTOVER_PRELIVE_FINGERPRINT_INVALID", "pre-live fingerprint is invalid")
    if cutover_id != expected_cutover_id(completion, pre_fp):
        fail("RUNTIME_CUTOVER_ID_MISMATCH", "cutover ID does not match immutable binding")
    project = record.get("project")
    if not isinstance(project, str) or not PROJECT.fullmatch(project):
        fail("RUNTIME_CUTOVER_PROJECT_INVALID", "journal Compose project is invalid")
    mutable = record.get("mutableServices")
    preserved = record.get("preservedServices")
    if not isinstance(mutable, list) or [item.get("service") for item in mutable if isinstance(item, dict)] != list(MUTABLE_SERVICES):
        fail("RUNTIME_CUTOVER_MUTABLE_SERVICES_INVALID", "journal mutable services are invalid")
    if not isinstance(preserved, list) or [item.get("service") for item in preserved if isinstance(item, dict)] != list(PRESERVED_SERVICES):
        fail("RUNTIME_CUTOVER_PRESERVED_SERVICES_INVALID", "journal preserved services are invalid")
    if [item.get("backupState") for item in mutable] != ["DISABLED", "DISABLED", "DISABLED"]:
        fail("RUNTIME_CUTOVER_PRESTATE_INVALID", "journal mutable services must be DISABLED")
    for item in mutable + preserved:
        cid = item.get("containerId")
        if not isinstance(cid, str) or not DOCKER_ID.fullmatch(cid):
            fail("RUNTIME_CUTOVER_CONTAINER_ID_INVALID", "journal container ID is invalid")
    if record.get("recreateServices") != list(MUTABLE_SERVICES):
        fail("RUNTIME_CUTOVER_RECREATE_SET_INVALID", "journal recreate service set is invalid")
    if (
        record.get("targetBackupState") != "ENABLED"
        or record.get("rollbackBackupState") != "DISABLED"
        or record.get("rollbackPolicy") != "RESTORE_PLAN_V2_ENV_AND_RECREATE_MUTABLE_SERVICES"
        or record.get("libsqlPolicy") != "PRESERVE_CONTAINER_ID"
        or record.get("caddyPolicy") != "PRESERVE_CONTAINER_ID"
        or record.get("cutoverJournalRequiredBeforeMutation") is not True
        or record.get("runtimeMutationStarted") is not False
        or record.get("liveRuntimeChanged") is not False
        or record.get("operationalActivationCompleted") is not False
    ):
        fail("RUNTIME_CUTOVER_POLICY_INVALID", "journal safety policy is invalid")
    fingerprint = record.get("journalFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("RUNTIME_CUTOVER_JOURNAL_FINGERPRINT_INVALID", "journal fingerprint is invalid")
    body = dict(record)
    body.pop("journalFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode("utf-8"))):
        fail("RUNTIME_CUTOVER_JOURNAL_FINGERPRINT_MISMATCH", "journal fingerprint does not match")


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": ENVELOPE_VERSION, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def ensure_root(path: Path) -> None:
    if not path.is_absolute():
        fail("RUNTIME_CUTOVER_OUTPUT_NOT_ABSOLUTE", "output root must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("RUNTIME_CUTOVER_OUTPUT_UNSAFE", "output root must be a non-symlink directory")
    os.chmod(path, 0o700)


def journal_path(root: Path, activation_id: str, create: bool) -> Path:
    ensure_root(root)
    directory = root / activation_id
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or not directory.is_dir():
            fail("RUNTIME_CUTOVER_DIR_UNSAFE", "cutover directory must be a non-symlink directory")
        os.chmod(directory, 0o700)
    elif directory.is_symlink() or not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) & 0o077:
        fail("RUNTIME_CUTOVER_DIR_UNSAFE", "cutover directory is missing or unsafe")
    return directory / PENDING_FILE


def read_journal(path: Path, key: bytes, completion: dict[str, Any]) -> dict[str, Any]:
    if not path.is_absolute() or path.name != PENDING_FILE or path.is_symlink() or not path.is_file():
        fail("RUNTIME_CUTOVER_JOURNAL_UNSAFE", "journal must be the canonical regular file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        fail("RUNTIME_CUTOVER_JOURNAL_PERMISSIONS_UNSAFE", "journal must be private")
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("RUNTIME_CUTOVER_JOURNAL_INVALID: journal is not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != ENVELOPE_VERSION or not isinstance(envelope.get("record"), dict):
        fail("RUNTIME_CUTOVER_JOURNAL_INVALID", "journal envelope is invalid")
    record = envelope["record"]
    validate_record(record, completion)
    signature = envelope.get("signature")
    if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
        fail("RUNTIME_CUTOVER_JOURNAL_SIGNATURE_INVALID", "journal signature is invalid")
    if not hmac.compare_digest(signature, sign_record(record, key)):
        fail("RUNTIME_CUTOVER_JOURNAL_SIGNATURE_MISMATCH", "journal HMAC does not match")
    return envelope


def persist_journal(path: Path, envelope: dict[str, Any]) -> bool:
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
    parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    return True


def classify_live(record: dict[str, Any], summary: dict[str, Any], env_state: str) -> tuple[str, str, bool]:
    preserved_now = {item["service"]: item["containerId"] for item in summary["preservedServices"]}
    preserved_bound = {item["service"]: item["containerId"] for item in record["preservedServices"]}
    if preserved_now != preserved_bound:
        return "BLOCKED", "PRESERVED_CONTAINER_ID_DRIFT", False
    if summary["project"] != record["project"]:
        return "BLOCKED", "COMPOSE_PROJECT_DRIFT", False
    states = [item["backupState"] for item in summary["mutableServices"]]
    if any(state == "UNKNOWN" for state in states):
        return "BLOCKED", "MUTABLE_RUNTIME_STATE_UNKNOWN", False
    if env_state == "PRE_ACTIVATION":
        return "ENV_PRE_ACTIVATION", "FILE_CONFIGURATION_HAS_BEEN_ROLLED_BACK", False
    if env_state != "TARGET":
        return "BLOCKED", "ENV_FINGERPRINT_DRIFT", False
    if states == ["DISABLED", "DISABLED", "DISABLED"]:
        current_ids = {item["service"]: item["containerId"] for item in summary["mutableServices"]}
        bound_ids = {item["service"]: item["containerId"] for item in record["mutableServices"]}
        if current_ids != bound_ids:
            return "BLOCKED", "PRE_LIVE_CONTAINER_ID_DRIFT", False
        if live_fingerprint(summary) != record["preLiveFingerprint"]:
            return "BLOCKED", "PRE_LIVE_FINGERPRINT_DRIFT", False
        return "READY_TO_CUTOVER", "BOUND_DISABLED_RUNTIME_STILL_ACTIVE", True
    if states == ["ENABLED", "ENABLED", "ENABLED"]:
        return "READY_TO_VALIDATE", "TARGET_RUNTIME_ALREADY_ACTIVE", False
    return "RECOVER_TARGET_RECREATE", "PARTIAL_KNOWN_RUNTIME_CUTOVER", True


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    completion = run_completion_authenticator(args)
    if completion.get("envState") != "TARGET" or completion.get("runtimeCutoverAllowed") is not True:
        fail("RUNTIME_CUTOVER_FILE_STATE_INVALID", "completed file activation must still be in TARGET state before journal creation")
    live = load_live(args)
    summary = live_summary(live)
    record = make_record(completion, summary, args.started_at or now_utc())
    key = read_key(args.key_file)
    path = journal_path(args.output_root, completion["activationId"], create=True)
    created = False
    if path.exists():
        envelope = read_journal(path, key, completion)
        if live_fingerprint(summary) != envelope["record"]["preLiveFingerprint"]:
            fail("RUNTIME_CUTOVER_PRELIVE_DRIFT", "live pre-cutover state changed after journal creation")
    else:
        envelope = {"envelopeVersion": ENVELOPE_VERSION, "record": record, "signature": sign_record(record, key)}
        created = persist_journal(path, envelope)
        if not created:
            envelope = read_journal(path, key, completion)
    status, reason, mutation_allowed = classify_live(envelope["record"], summary, completion["envState"])
    if status != "READY_TO_CUTOVER":
        fail("RUNTIME_CUTOVER_PREPARE_STATE_INVALID", f"new journal must remain in READY_TO_CUTOVER, got {status}")
    return {
        "mode": "BACKUP_PRIVACY_RUNTIME_CUTOVER_JOURNAL",
        "status": status,
        "reason": reason,
        "activationId": completion["activationId"],
        "cutoverId": envelope["record"]["cutoverId"],
        "journalFingerprint": envelope["record"]["journalFingerprint"],
        "journalPath": str(path),
        "journalCreated": created,
        "journalReused": not created,
        "runtimeMutationAllowed": mutation_allowed,
        "liveRuntimeChanged": False,
        "operationalActivationCompleted": False,
    }


def check(args: argparse.Namespace) -> dict[str, Any]:
    completion = run_completion_authenticator(args)
    key = read_key(args.key_file)
    envelope = read_journal(args.journal, key, completion)
    if args.journal.parent.name != completion["activationId"]:
        fail("RUNTIME_CUTOVER_JOURNAL_PATH_BINDING_MISMATCH", "journal parent does not match activation ID")
    summary = live_summary(load_live(args))
    status, reason, mutation_allowed = classify_live(envelope["record"], summary, completion["envState"])
    return {
        "mode": "BACKUP_PRIVACY_RUNTIME_CUTOVER_ASSESSMENT",
        "status": status,
        "reason": reason,
        "activationId": completion["activationId"],
        "cutoverId": envelope["record"]["cutoverId"],
        "journalFingerprint": envelope["record"]["journalFingerprint"],
        "envState": completion["envState"],
        "runtimeMutationAllowed": mutation_allowed,
        "liveRuntimeChanged": status in {"READY_TO_VALIDATE", "RECOVER_TARGET_RECREATE"},
        "operationalActivationCompleted": False,
    }


def add_common(parser: argparse.ArgumentParser) -> None:
    root = Path(__file__).resolve().parents[2]
    parser.add_argument("--completion-checker", type=Path, default=root / "infra/backup/check-backup-privacy-activation-completion.py")
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
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
    prepare_parser.add_argument("--started-at")
    check_parser = sub.add_parser("check")
    add_common(check_parser)
    check_parser.add_argument("--journal", required=True, type=Path)
    args = parser.parse_args()
    if getattr(args, "started_at", None) is not None:
        validate_timestamp(args.started_at)
    try:
        result = prepare(args) if args.command == "prepare" else check(args)
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0 if result["status"] != "BLOCKED" else 1
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_RUNTIME_CUTOVER",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "runtimeMutationAllowed": False,
            "liveRuntimeChanged": False,
            "operationalActivationCompleted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
