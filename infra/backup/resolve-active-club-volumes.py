#!/usr/bin/env python3
"""Resolve the four active Club application data volumes from rendered Compose + docker inspect evidence."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

VOLUME_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
ROLE_SPECS = (
    ("libsql", "libsql", "/var/lib/sqld"),
    ("reports", "app", "/var/lib/masters/reports"),
    ("tenantExports", "app", "/var/lib/masters/exports"),
    ("dataSubjectDelivery", "app", "/var/lib/masters/data-subject-delivery-packages"),
)


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"{label} is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} is not valid JSON: {path}") from exc


def exactly_one(items: list[dict[str, Any]], label: str) -> dict[str, Any]:
    if len(items) != 1:
        fail(f"{label} must resolve exactly once, found {len(items)}")
    return items[0]


def inspect_object(raw: Any, service: str) -> dict[str, Any]:
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        fail(f"docker inspect evidence for {service} must contain exactly one container")
    return raw[0]


def compose_volume_for_target(compose: dict[str, Any], service: str, target: str) -> str:
    services = compose.get("services")
    if not isinstance(services, dict) or not isinstance(services.get(service), dict):
        fail(f"Rendered Compose is missing service {service}")
    volumes = services[service].get("volumes", [])
    if not isinstance(volumes, list):
        fail(f"Rendered Compose service {service} volumes are invalid")
    matches = [
        item
        for item in volumes
        if isinstance(item, dict)
        and item.get("type") == "volume"
        and item.get("target") == target
        and isinstance(item.get("source"), str)
    ]
    match = exactly_one(matches, f"Rendered Compose volume {service}:{target}")
    logical_name = match["source"]
    top_level = compose.get("volumes")
    if not isinstance(top_level, dict) or logical_name not in top_level:
        fail(f"Rendered Compose volume {logical_name} is not declared at top level")
    return logical_name


def verify_container_identity(compose: dict[str, Any], container: dict[str, Any], service: str) -> None:
    labels = container.get("Config", {}).get("Labels", {})
    if not isinstance(labels, dict):
        fail(f"docker inspect labels for {service} are invalid")
    if labels.get("com.docker.compose.service") != service:
        fail(f"docker inspect container is not the rendered Compose service {service}")
    project = compose.get("name")
    if isinstance(project, str) and project:
        if labels.get("com.docker.compose.project") != project:
            fail(f"docker inspect container for {service} belongs to a different Compose project")


def active_volume_for_target(container: dict[str, Any], service: str, target: str) -> str:
    mounts = container.get("Mounts")
    if not isinstance(mounts, list):
        fail(f"docker inspect mounts for {service} are invalid")
    matches = [
        item
        for item in mounts
        if isinstance(item, dict)
        and item.get("Type") == "volume"
        and item.get("Destination") == target
        and isinstance(item.get("Name"), str)
    ]
    match = exactly_one(matches, f"Active Docker volume {service}:{target}")
    if match.get("RW") is not True:
        fail(f"Active Docker volume {service}:{target} is unexpectedly read-only")
    name = match["Name"]
    if not VOLUME_NAME.fullmatch(name):
        fail(f"Active Docker volume {service}:{target} has an unsafe name")
    return name


def resolve(compose: dict[str, Any], app: dict[str, Any], libsql: dict[str, Any]) -> dict[str, str]:
    containers = {"app": app, "libsql": libsql}
    for service, container in containers.items():
        verify_container_identity(compose, container, service)

    resolved: dict[str, str] = {}
    logical_names: dict[str, str] = {}
    for role, service, target in ROLE_SPECS:
        logical_names[role] = compose_volume_for_target(compose, service, target)
        resolved[role] = active_volume_for_target(containers[service], service, target)

    if len(set(logical_names.values())) != len(logical_names):
        fail("Rendered Compose application data volume roles must use distinct named volumes")
    if len(set(resolved.values())) != len(resolved):
        fail("Active application data volume roles must resolve to distinct Docker volumes")

    declared = compose.get("volumes")
    if isinstance(declared, dict):
        for role, logical_name in logical_names.items():
            definition = declared.get(logical_name)
            if isinstance(definition, dict):
                explicit_name = definition.get("name")
                if isinstance(explicit_name, str) and explicit_name and explicit_name != resolved[role]:
                    fail(
                        f"Active Docker volume for {role} does not match rendered explicit Compose name"
                    )
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compose-json", required=True, type=Path)
    parser.add_argument("--app-inspect-json", required=True, type=Path)
    parser.add_argument("--libsql-inspect-json", required=True, type=Path)
    parser.add_argument("--format", choices=("json", "lines"), default="json")
    args = parser.parse_args()

    try:
        compose_raw = read_json(args.compose_json, "Rendered Compose config")
        if not isinstance(compose_raw, dict):
            fail("Rendered Compose config must be a JSON object")
        app = inspect_object(read_json(args.app_inspect_json, "app docker inspect"), "app")
        libsql = inspect_object(read_json(args.libsql_inspect_json, "libsql docker inspect"), "libsql")
        resolved = resolve(compose_raw, app, libsql)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if args.format == "lines":
        for key in ("libsql", "reports", "tenantExports", "dataSubjectDelivery"):
            print(resolved[key])
    else:
        print(json.dumps(resolved, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
