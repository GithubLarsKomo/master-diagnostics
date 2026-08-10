#!/usr/bin/env python3
"""Read-only gate immediately before online-update writer shutdown."""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


class PreStopError(ValueError):
    pass


def fail(message: str) -> None:
    raise PreStopError(message)


def load_module(file_name: str, module_name: str):
    path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        fail(f"Unable to load {module_name} module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_regular_file(path: Path, label: str) -> Path:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    return path


def read_json(path: Path, label: str) -> Any:
    require_regular_file(path, label)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PreStopError(f"{label} is not valid JSON") from exc


def read_key(path: Path, label: str) -> bytes:
    require_regular_file(path, label)
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise PreStopError(f"{label} is not valid base64") from exc
    if len(key) != 32:
        fail(f"{label} must decode to exactly 32 bytes")
    return key


def run_read_only_docker(args: list[str], label: str) -> str:
    allowed = (
        args[:2] == ["image", "inspect"] and len(args) == 3
        or args[:1] == ["inspect"] and len(args) == 2
        or "config" in args and args[-2:] == ["--format", "json"]
        or "ps" in args and "-q" in args
    )
    if not allowed:
        fail(f"Unsafe Docker command rejected by pre-stop assessment: {' '.join(args)}")
    try:
        completed = subprocess.run(
            ["docker", *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as exc:
        raise PreStopError("Docker CLI is unavailable") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise PreStopError(f"{label} failed" + (f": {detail}" if detail else "")) from exc
    return completed.stdout


def compose_base(env_file: Path, compose_file: Path) -> list[str]:
    return ["compose", "--env-file", str(env_file), "-f", str(compose_file)]


def verify_target_image(reference: str) -> dict[str, Any]:
    if not isinstance(reference, str) or "@sha256:" not in reference or reference.startswith("-"):
        fail("Online update target image reference is not immutable")
    raw = run_read_only_docker(["image", "inspect", reference], f"Inspecting target image {reference}")
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PreStopError("Docker image inspect returned invalid JSON") from exc
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        fail("Docker image inspect must return exactly one image")
    image = values[0]
    repo_digests = image.get("RepoDigests")
    image_id = image.get("Id")
    if not isinstance(repo_digests, list) or reference not in repo_digests:
        fail(f"Target image does not expose exact journal-bound RepoDigest: {reference}")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        fail("Target image ID is invalid")
    return {
        "reference": reference,
        "imageId": image_id,
        "repoDigests": sorted(str(value) for value in repo_digests),
    }


def derive_writer_services(compose: dict[str, Any]) -> list[str]:
    services = compose.get("services")
    if not isinstance(services, dict):
        fail("Rendered Club Compose has no services object")
    writers: list[str] = []
    for name, service in services.items():
        if not isinstance(name, str) or not isinstance(service, dict):
            fail("Rendered Club Compose service entry is invalid")
        environment = service.get("environment", {})
        if not isinstance(environment, dict):
            continue
        if environment.get("DATABASE_URL") != "http://libsql:8080":
            continue
        if service.get("restart") == "no":
            continue
        profiles = service.get("profiles")
        if isinstance(profiles, list) and profiles:
            continue
        writers.append(name)
    writers.sort()
    if not writers:
        fail("Rendered Club Compose exposes no long-running application writers")
    return writers


def parse_single_container_id(raw: str, service: str) -> str:
    ids = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(ids) != 1 or not re.fullmatch(r"[0-9a-f]{12,64}", ids[0]):
        fail(f"Expected exactly one running writer container for {service}, found {len(ids)}")
    return ids[0]


def verify_writer_container(raw: str, service: str, project: str, container_id: str) -> dict[str, Any]:
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PreStopError(f"Docker inspect for writer {service} returned invalid JSON") from exc
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        fail(f"Docker inspect for writer {service} must contain exactly one container")
    item = values[0]
    actual_id = item.get("Id")
    if not isinstance(actual_id, str) or not actual_id.startswith(container_id):
        fail(f"Writer {service} container identity changed during assessment")
    labels = item.get("Config", {}).get("Labels", {})
    if not isinstance(labels, dict):
        fail(f"Writer {service} Compose labels are invalid")
    if labels.get("com.docker.compose.service") != service or labels.get("com.docker.compose.project") != project:
        fail(f"Writer {service} does not belong to the expected Compose service/project")
    state = item.get("State")
    if not isinstance(state, dict) or state.get("Running") is not True or state.get("Status") != "running":
        fail(f"Writer {service} is not running")
    image_id = item.get("Image")
    configured_image = item.get("Config", {}).get("Image")
    started_at = state.get("StartedAt")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        fail(f"Writer {service} image identity is invalid")
    if not isinstance(configured_image, str) or not configured_image:
        fail(f"Writer {service} configured image identity is missing")
    if not isinstance(started_at, str) or not started_at:
        fail(f"Writer {service} start identity is missing")
    return {
        "service": service,
        "containerId": actual_id,
        "imageId": image_id,
        "configuredImage": configured_image,
        "startedAt": started_at,
        "running": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--event-key", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        require_regular_file(args.compose_file, "Club Compose file")
        require_regular_file(args.env_file, "Club environment file")
        journal_module = load_module("persist-online-update-execution-journal.py", "master_diagnostics_online_update_execution_journal")
        event_module = load_module("persist-online-update-execution-event.py", "master_diagnostics_online_update_execution_event")

        journal_key = journal_module.read_key(args.journal_key)
        journal = journal_module.verify_envelope(read_json(args.journal, "Online update execution journal"), journal_key)
        event_key = read_key(args.event_key, "Online update execution-event key")
        events = event_module.read_events(args.events_dir, event_key, journal)
        if not events or events[-1]["record"]["phase"] != "IMAGES_ACQUIRED":
            phase = events[-1]["record"]["phase"] if events else "NONE"
            fail(f"Pre-stop assessment requires current phase IMAGES_ACQUIRED, found {phase}")
        if events[-1]["record"].get("productionMutationStarted") is not False:
            fail("Pre-stop assessment requires production mutation to remain unstarted")

        target_images = [verify_target_image(item["reference"]) for item in journal["record"]["images"]]

        base = compose_base(args.env_file, args.compose_file)
        rendered_raw = run_read_only_docker([*base, "config", "--format", "json"], "Rendering Club Compose")
        try:
            rendered = json.loads(rendered_raw)
        except json.JSONDecodeError as exc:
            raise PreStopError("Rendered Club Compose is not valid JSON") from exc
        if not isinstance(rendered, dict):
            fail("Rendered Club Compose is invalid")
        project = rendered.get("name")
        if not isinstance(project, str) or not project:
            fail("Rendered Club Compose project identity is missing")
        writers = derive_writer_services(rendered)

        writer_identities: list[dict[str, Any]] = []
        for service in writers:
            container_id = parse_single_container_id(
                run_read_only_docker([*base, "ps", "-q", service], f"Resolving writer {service}"),
                service,
            )
            writer_identities.append(
                verify_writer_container(
                    run_read_only_docker(["inspect", container_id], f"Inspecting writer {service}"),
                    service,
                    project,
                    container_id,
                )
            )

        print(json.dumps({
            "mode": "CLUB_ONLINE_UPDATE_PRE_STOP_ASSESSMENT_V1",
            "status": "READY_FOR_WRITER_STOP_EVIDENCE",
            "targetVersion": journal["record"]["targetVersion"],
            "journalSignature": journal["signature"],
            "currentEventPhase": events[-1]["record"]["phase"],
            "currentEventSignature": events[-1]["signature"],
            "targetImagesLocallyVerified": True,
            "targetImages": target_images,
            "composeProject": project,
            "writerServices": writers,
            "writers": writer_identities,
            "productionMutationStarted": False,
            "writerStopStarted": False,
            "migrationStarted": False,
            "updateExecuted": False,
        }, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, PreStopError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
