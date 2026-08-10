#!/usr/bin/env python3
"""Acquire only the exact journal-bound online-update images, with crash-safe signed evidence."""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AcquisitionError(ValueError):
    pass


def fail(message: str) -> None:
    raise AcquisitionError(message)


def load_module(file_name: str, module_name: str):
    path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        fail(f"Unable to load {module_name} module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path, label: str) -> Any:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AcquisitionError(f"{label} is not valid JSON") from exc


def read_key(path: Path, label: str) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{label} must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise AcquisitionError(f"{label} is not valid base64") from exc
    if len(key) != 32:
        fail(f"{label} must decode to exactly 32 bytes")
    return key


def canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_docker(args: list[str], label: str) -> str:
    try:
        completed = subprocess.run(
            ["docker", *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as exc:
        raise AcquisitionError("Docker CLI is unavailable") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise AcquisitionError(f"{label} failed" + (f": {detail}" if detail else "")) from exc
    return completed.stdout


def verify_local_reference(reference: str) -> dict[str, Any]:
    raw = run_docker(["image", "inspect", reference], f"Inspecting acquired image {reference}")
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AcquisitionError("Docker image inspect returned invalid JSON") from exc
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        fail("Docker image inspect must return exactly one image")
    image = values[0]
    repo_digests = image.get("RepoDigests")
    if not isinstance(repo_digests, list) or reference not in repo_digests:
        fail(f"Acquired image does not expose the exact journal-bound RepoDigest: {reference}")
    image_id = image.get("Id")
    if not isinstance(image_id, str) or not image_id.startswith("sha256:"):
        fail("Acquired image ID is invalid")
    return {"reference": reference, "imageId": image_id, "repoDigests": sorted(str(item) for item in repo_digests)}


def acquire_reference(reference: str) -> dict[str, Any]:
    if "@sha256:" not in reference:
        fail("Online update image reference must be immutable and digest-pinned")
    run_docker(["pull", reference], f"Pulling immutable image {reference}")
    return verify_local_reference(reference)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--event-key", required=True, type=Path)
    args = parser.parse_args()
    try:
        journal_module = load_module("persist-online-update-execution-journal.py", "master_diagnostics_online_update_execution_journal")
        event_module = load_module("persist-online-update-execution-event.py", "master_diagnostics_online_update_execution_event")
        journal_key = journal_module.read_key(args.journal_key)
        journal = journal_module.verify_envelope(read_json(args.journal, "Online update execution journal"), journal_key)
        event_key = read_key(args.event_key, "Online update execution-event key")
        events = event_module.read_events(args.events_dir, event_key, journal)

        if events:
            last_phase = events[-1]["record"]["phase"]
            if last_phase not in {"IMAGE_ACQUISITION_STARTED", "IMAGES_ACQUIRED"}:
                fail(f"Image acquisition executor cannot run after phase {last_phase}")
        else:
            _, _, _, events = event_module.persist_event(
                args.events_dir,
                event_key,
                journal,
                "IMAGE_ACQUISITION_STARTED",
                canonical_now(),
            )

        acquired = [acquire_reference(item["reference"]) for item in journal["record"]["images"]]

        current_events = event_module.read_events(args.events_dir, event_key, journal)
        if current_events[-1]["record"]["phase"] == "IMAGE_ACQUISITION_STARTED":
            _, created, completed, current_events = event_module.persist_event(
                args.events_dir,
                event_key,
                journal,
                "IMAGES_ACQUIRED",
                canonical_now(),
            )
        elif current_events[-1]["record"]["phase"] == "IMAGES_ACQUIRED":
            created = False
            completed = current_events[-1]
        else:
            fail("Image acquisition evidence advanced unexpectedly during execution")

        print(json.dumps({
            "mode": "CLUB_ONLINE_UPDATE_IMAGE_ACQUISITION_V1",
            "status": "EXACT_IMAGES_ACQUIRED",
            "targetVersion": journal["record"]["targetVersion"],
            "images": acquired,
            "eventCreated": created,
            "eventReused": not created,
            "eventSignature": completed["signature"],
            "phase": completed["record"]["phase"],
            "productionMutationStarted": False,
            "migrationStarted": False,
            "updateExecuted": False,
        }, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, AcquisitionError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
