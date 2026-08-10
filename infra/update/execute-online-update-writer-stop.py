#!/usr/bin/env python3
"""Stop only the exact intent-bound application writers, with crash-safe signed evidence."""

from __future__ import annotations

import argparse
import base64
import fcntl
import importlib.util
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DOCKER_TIMEOUT_SECONDS = 30


class WriterStopError(ValueError):
    pass


def fail(message: str) -> None:
    raise WriterStopError(message)


def load_module(file_name: str, module_name: str):
    path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        fail(f"Unable to load {module_name} module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_regular_file(path: Path, label: str) -> Path:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    return path


def require_safe_dir(path: Path, label: str) -> Path:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_dir():
        fail(f"{label} must be a non-symlink directory")
    return path


def read_json(path: Path, label: str) -> Any:
    require_regular_file(path, label)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise WriterStopError(f"{label} is not valid JSON") from exc


def read_key(path: Path, label: str) -> bytes:
    require_regular_file(path, label)
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise WriterStopError(f"{label} is not valid base64") from exc
    if len(key) != 32:
        fail(f"{label} must decode to exactly 32 bytes")
    return key


@contextmanager
def execution_lock(events_dir: Path) -> Iterator[None]:
    require_safe_dir(events_dir, "Online update execution-event directory")
    lock_path = events_dir / ".writer-stop-executor.lock"
    if lock_path.exists() and (lock_path.is_symlink() or not lock_path.is_file()):
        fail("Writer-stop executor lock path is unsafe")
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def run_docker(args: list[str], label: str) -> str:
    is_inspect = args[:1] == ["inspect"] and len(args) == 2
    is_stop = args[:1] == ["stop"] and len(args) == 2 and re.fullmatch(r"[0-9a-f]{12,64}", args[1]) is not None
    is_compose_ps = args and args[0] == "compose" and "ps" in args and "-q" in args
    if not (is_inspect or is_stop or is_compose_ps):
        fail(f"Unsafe Docker command rejected by writer-stop executor: {' '.join(args)}")
    try:
        completed = subprocess.run(
            ["docker", *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=DOCKER_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise WriterStopError("Docker CLI is unavailable") from exc
    except subprocess.TimeoutExpired as exc:
        raise WriterStopError(f"{label} timed out") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise WriterStopError(f"{label} failed" + (f": {detail}" if detail else "")) from exc
    return completed.stdout


def compose_base(env_file: Path, compose_file: Path) -> list[str]:
    return ["compose", "--env-file", str(env_file), "-f", str(compose_file)]


def parse_running_ids(raw: str, service: str) -> list[str]:
    ids = [line.strip() for line in raw.splitlines() if line.strip()]
    if any(re.fullmatch(r"[0-9a-f]{12,64}", value) is None for value in ids):
        fail(f"Running container identity for {service} is invalid")
    if len(ids) > 1:
        fail(f"Expected at most one running container for {service}, found {len(ids)}")
    return ids


def inspect_container(container_id: str, label: str) -> dict[str, Any]:
    raw = run_docker(["inspect", container_id], f"Inspecting {label}")
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WriterStopError(f"Docker inspect for {label} returned invalid JSON") from exc
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        fail(f"Docker inspect for {label} must contain exactly one container")
    return values[0]


def verify_bound_writer(item: dict[str, Any], project: str, compose_args: list[str]) -> dict[str, Any]:
    service = item["service"]
    container_id = item["containerId"]
    inspected = inspect_container(container_id, f"writer {service}")
    actual_id = inspected.get("Id")
    if not isinstance(actual_id, str) or actual_id != container_id:
        fail(f"Writer {service} bound container identity changed or disappeared")
    labels = inspected.get("Config", {}).get("Labels", {})
    if not isinstance(labels, dict) or labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != service:
        fail(f"Writer {service} no longer matches bound Compose identity")
    if inspected.get("Image") != item["imageId"]:
        fail(f"Writer {service} image ID no longer matches writer-stop intent")
    if inspected.get("Config", {}).get("Image") != item["configuredImage"]:
        fail(f"Writer {service} configured image no longer matches writer-stop intent")
    state = inspected.get("State")
    if not isinstance(state, dict) or state.get("StartedAt") != item["startedAt"]:
        fail(f"Writer {service} start identity no longer matches writer-stop intent")
    running = state.get("Running") is True and state.get("Status") == "running"
    running_ids = parse_running_ids(
        run_docker([*compose_args, "ps", "-q", service], f"Resolving running writer {service}"), service
    )
    if running:
        if running_ids != [container_id]:
            fail(f"Writer {service} has a replacement or ambiguous running container")
    elif running_ids:
        fail(f"Writer {service} has a replacement running after the bound container stopped")
    return {"service": service, "containerId": container_id, "running": running, "status": state.get("Status")}


def verify_libsql_available(compose_args: list[str], project: str) -> dict[str, Any]:
    ids = parse_running_ids(run_docker([*compose_args, "ps", "-q", "libsql"], "Resolving libSQL container"), "libsql")
    if len(ids) != 1:
        fail("Writer-stop executor requires exactly one running libSQL container")
    item = inspect_container(ids[0], "libSQL")
    labels = item.get("Config", {}).get("Labels", {})
    if not isinstance(labels, dict) or labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != "libsql":
        fail("Running libSQL container does not match expected Compose identity")
    state = item.get("State")
    if not isinstance(state, dict) or state.get("Running") is not True or state.get("Status") != "running":
        fail("libSQL is not running after writer stop")
    health = state.get("Health")
    if not isinstance(health, dict) or health.get("Status") != "healthy":
        fail("libSQL is not healthy after writer stop")
    return {"containerId": ids[0], "running": True, "healthy": True}


def run_fresh_assessment(args: argparse.Namespace) -> dict[str, Any]:
    assessor = Path(__file__).with_name("assess-online-update-pre-stop.py")
    command = [
        sys.executable,
        str(assessor),
        "--journal",
        str(args.journal),
        "--journal-key",
        str(args.journal_key),
        "--events-dir",
        str(args.events_dir),
        "--event-key",
        str(args.event_key),
        "--compose-file",
        str(args.compose_file),
        "--env-file",
        str(args.env_file),
    ]
    try:
        completed = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=DOCKER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise WriterStopError("Fresh pre-stop assessment timed out") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise WriterStopError("Fresh pre-stop assessment failed" + (f": {detail}" if detail else "")) from exc
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise WriterStopError("Fresh pre-stop assessment returned invalid JSON") from exc
    if not isinstance(value, dict):
        fail("Fresh pre-stop assessment returned invalid evidence")
    return value


def find_event(events: list[dict[str, Any]], phase: str) -> dict[str, Any] | None:
    return next((event for event in events if event["record"]["phase"] == phase), None)


def persist_rollback_started(event_module: Any, events_dir: Path, event_key: bytes, journal: dict[str, Any]) -> dict[str, Any] | None:
    events = event_module.read_events(events_dir, event_key, journal)
    if not events:
        return None
    last_phase = events[-1]["record"]["phase"]
    if last_phase == "ROLLBACK_STARTED":
        return events[-1]
    if last_phase not in {"WRITER_STOP_STARTED", "WRITERS_STOPPED"}:
        return None
    _, _, envelope, _ = event_module.persist_event(events_dir, event_key, journal, "ROLLBACK_STARTED", canonical_now())
    return envelope


def execute(args: argparse.Namespace) -> dict[str, Any]:
    require_regular_file(args.compose_file, "Club Compose file")
    require_regular_file(args.env_file, "Club environment file")
    journal_module = load_module("persist-online-update-execution-journal.py", "master_diagnostics_online_update_execution_journal")
    event_module = load_module("persist-online-update-execution-event.py", "master_diagnostics_online_update_execution_event")
    intent_module = load_module("persist-online-update-writer-stop-intent.py", "master_diagnostics_online_update_writer_stop_intent")

    journal_key = journal_module.read_key(args.journal_key)
    journal = journal_module.verify_envelope(read_json(args.journal, "Online update execution journal"), journal_key)
    event_key = read_key(args.event_key, "Online update execution-event key")
    intent_key = intent_module.read_key(args.intent_key)
    intent = intent_module.verify_envelope(read_json(args.intent, "Online update writer-stop intent"), intent_key)
    irec = intent["record"]
    if irec["journalSignature"] != journal["signature"] or irec["targetVersion"] != journal["record"]["targetVersion"]:
        fail("Writer-stop intent does not match execution journal")

    with execution_lock(args.events_dir):
        events = event_module.read_events(args.events_dir, event_key, journal)
        if not events:
            fail("Writer-stop executor requires existing online update execution events")
        last_phase = events[-1]["record"]["phase"]
        if last_phase not in {"IMAGES_ACQUIRED", "WRITER_STOP_STARTED", "WRITERS_STOPPED"}:
            fail(f"Writer-stop executor cannot run after phase {last_phase}")
        images_acquired = find_event(events, "IMAGES_ACQUIRED")
        if images_acquired is None or irec["imagesAcquiredEventSignature"] != images_acquired["signature"]:
            fail("Writer-stop intent lost binding to original IMAGES_ACQUIRED event")

        if last_phase == "IMAGES_ACQUIRED":
            fresh = run_fresh_assessment(args)
            if not intent_module.same_binding(irec, fresh):
                fail("Fresh pre-stop assessment no longer matches durable writer-stop intent")
            _, _, started, events = event_module.persist_event(
                args.events_dir, event_key, journal, "WRITER_STOP_STARTED", canonical_now()
            )
            last_phase = started["record"]["phase"]

        compose_args = compose_base(args.env_file, args.compose_file)
        project = irec["composeProject"]
        before: list[dict[str, Any]] = []
        try:
            for writer in irec["writers"]:
                state = verify_bound_writer(writer, project, compose_args)
                before.append(state)
                if state["running"]:
                    run_docker(["stop", writer["containerId"]], f"Stopping exact writer {writer['service']}")

            after = [verify_bound_writer(writer, project, compose_args) for writer in irec["writers"]]
            if any(item["running"] for item in after):
                fail("Not all intent-bound application writers are stopped")
            libsql = verify_libsql_available(compose_args, project)

            current_events = event_module.read_events(args.events_dir, event_key, journal)
            if current_events[-1]["record"]["phase"] == "WRITER_STOP_STARTED":
                _, created, stopped, current_events = event_module.persist_event(
                    args.events_dir, event_key, journal, "WRITERS_STOPPED", canonical_now()
                )
            elif current_events[-1]["record"]["phase"] == "WRITERS_STOPPED":
                created = False
                stopped = current_events[-1]
            else:
                fail("Writer-stop execution evidence advanced unexpectedly")
        except (OSError, WriterStopError, ValueError) as exc:
            rollback = persist_rollback_started(event_module, args.events_dir, event_key, journal)
            suffix = f"; ROLLBACK_STARTED={rollback['signature']}" if rollback is not None else ""
            raise WriterStopError(f"Writer-stop execution failed after production-mutation boundary: {exc}{suffix}") from exc

        return {
            "mode": "CLUB_ONLINE_UPDATE_WRITER_STOP_EXECUTOR_V1",
            "status": "APPLICATION_WRITERS_STOPPED",
            "targetVersion": journal["record"]["targetVersion"],
            "intentSignature": intent["signature"],
            "intentFingerprint": irec["intentFingerprint"],
            "writersBefore": before,
            "writersAfter": after,
            "libsql": libsql,
            "eventCreated": created,
            "eventReused": not created,
            "eventSignature": stopped["signature"],
            "phase": stopped["record"]["phase"],
            "productionMutationStarted": True,
            "writersStopped": True,
            "migrationStarted": False,
            "updateExecuted": False,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--event-key", required=True, type=Path)
    parser.add_argument("--intent", required=True, type=Path)
    parser.add_argument("--intent-key", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = execute(args)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, WriterStopError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
