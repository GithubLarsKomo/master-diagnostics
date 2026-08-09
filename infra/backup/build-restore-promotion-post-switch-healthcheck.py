#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VOLUME_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
ROLES = ("LIBSQL", "REPORTS", "TENANT_EXPORTS", "DATA_SUBJECT_DELIVERY")
SERVICES = ("libsql", "app", "export-cleanup", "retention-scan", "caddy")


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"{label} is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} is invalid JSON: {path}") from exc


def one_inspect(path: Path, service: str) -> dict[str, Any]:
    raw = read_json(path, f"{service} inspect")
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        fail(f"{service} inspect must contain exactly one container")
    obj = raw[0]
    labels = obj.get("Config", {}).get("Labels", {})
    if not isinstance(labels, dict) or labels.get("com.docker.compose.service") != service:
        fail(f"{service} inspect does not match the expected Compose service")
    return obj


def running(obj: dict[str, Any], service: str) -> None:
    state = obj.get("State")
    if not isinstance(state, dict) or state.get("Running") is not True:
        fail(f"{service} is not running")


def healthy(obj: dict[str, Any], service: str) -> None:
    running(obj, service)
    health = obj.get("State", {}).get("Health")
    if not isinstance(health, dict) or health.get("Status") != "healthy":
        fail(f"{service} is not healthy")


def parse_timestamp(value: str, label: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"{label} is not a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} is invalid") from exc
    return parsed.astimezone(timezone.utc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--current-volumes", required=True, type=Path)
    parser.add_argument("--rollback-volume-inspect", required=True, type=Path)
    for service in SERVICES:
        parser.add_argument(f"--{service}-inspect", required=True, type=Path)
    args = parser.parse_args()

    try:
        journal = read_json(args.journal, "switch journal")
        record = journal.get("record") if isinstance(journal, dict) else None
        if not isinstance(record, dict) or record.get("phase") != "PENDING":
            fail("Switch journal record is invalid")
        candidate_set_id = record.get("candidateSetId")
        if not isinstance(candidate_set_id, str) or not re.fullmatch(r"restore-[0-9a-f]{20}", candidate_set_id):
            fail("Switch journal candidateSetId is invalid")
        volumes = record.get("volumes")
        if not isinstance(volumes, list) or len(volumes) != 4:
            fail("Switch journal must contain exactly four volumes")

        candidate_names: list[str] = []
        rollback_names: list[str] = []
        candidate_report: list[dict[str, str]] = []
        for index, role in enumerate(ROLES):
            item = volumes[index]
            if not isinstance(item, dict) or item.get("role") != role:
                fail("Switch journal volume order is invalid")
            candidate = item.get("candidateVolumeName")
            rollback = item.get("rollbackVolumeName")
            if not isinstance(candidate, str) or not VOLUME_NAME.fullmatch(candidate):
                fail(f"Candidate volume for {role} is unsafe")
            if not isinstance(rollback, str) or not VOLUME_NAME.fullmatch(rollback):
                fail(f"Rollback volume for {role} is unsafe")
            candidate_names.append(candidate)
            rollback_names.append(rollback)
            candidate_report.append({"role": role, "volumeName": candidate})

        current = [line.strip() for line in args.current_volumes.read_text(encoding="utf-8").splitlines() if line.strip()]
        if current != candidate_names:
            fail("Current application volume set is not the journal-bound candidate set")

        rollback_raw = read_json(args.rollback_volume_inspect, "rollback volume inspect")
        if not isinstance(rollback_raw, list):
            fail("Rollback volume inspect result is invalid")
        observed_rollback = {item.get("Name") for item in rollback_raw if isinstance(item, dict)}
        if set(rollback_names) != observed_rollback:
            fail("Rollback volumes are not all retained")

        inspected = {service: one_inspect(getattr(args, f"{service.replace('-', '_')}_inspect"), service) for service in SERVICES}
        project_names = {
            inspected[service].get("Config", {}).get("Labels", {}).get("com.docker.compose.project")
            for service in SERVICES
        }
        if len(project_names) != 1 or None in project_names:
            fail("Post-switch services do not belong to one Compose project")

        healthy(inspected["libsql"], "libsql")
        healthy(inspected["app"], "app")
        running(inspected["export-cleanup"], "export-cleanup")
        running(inspected["retention-scan"], "retention-scan")
        running(inspected["caddy"], "caddy")

        journal_started = parse_timestamp(record.get("startedAt"), "Switch journal startedAt")
        caddy_created = parse_timestamp(inspected["caddy"].get("Created"), "Caddy Created")
        if caddy_created > journal_started:
            fail("Caddy container was recreated after durable switch journal creation")

        checked_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        result = {
            "mode": "CLUB_RESTORE_PROMOTION_POST_SWITCH_HEALTHCHECK",
            "status": "HEALTHY",
            "healthcheckVersion": 1,
            "checkedAt": checked_at,
            "candidateSetId": candidate_set_id,
            "currentVolumeSet": "CANDIDATE",
            "libsqlHealth": "HEALTHY",
            "appHealth": "HEALTHY",
            "exportCleanupRunning": True,
            "retentionScanRunning": True,
            "caddyPreserved": True,
            "rollbackVolumesRetained": True,
            "candidateVolumes": candidate_report,
        }
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except ValueError as exc:
        print(str(exc), file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
