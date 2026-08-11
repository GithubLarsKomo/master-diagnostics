#!/usr/bin/env python3
"""Execute a bounded online-update rollback through the existing restore pipeline."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOCK_FILE = "/run/lock/master-diagnostics-online-update-rollback.lock"
RESTORE_TIMEOUT_SECONDS = 15000
COMMAND_TIMEOUT_SECONDS = 60


class RollbackExecutorError(ValueError):
    pass


def fail(message: str) -> None:
    raise RollbackExecutorError(message)


def load_module(path: Path, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        fail(f"Unable to load {path}")
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
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RollbackExecutorError(f"{label} is not valid UTF-8 JSON") from exc


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def run(command: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RollbackExecutorError(f"Command could not be executed: {' '.join(command)}") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
        fail(f"Command failed: {' '.join(command)}: {detail}")
    return completed


def ensure_regular(path: Path, label: str) -> None:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{label} must be an absolute regular non-symlink file")


def parse_verified_report(
    report_path: Path,
    checker: Any,
    report_key: Path,
    bundle_name: str,
    bundle_sha256: str,
    rollback_started_at: str,
) -> dict[str, Any] | None:
    try:
        verified = checker.verify_report(report_path, report_key, bundle_name, bundle_sha256)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if verified.get("drillStatus") != "COMPLETED" or verified.get("practicalRestoreEvidenceVerified") is not True:
        return None
    envelope = read_json(report_path, "Verified restore RTO drill report")
    record = envelope.get("record")
    if not isinstance(record, dict):
        return None
    if record.get("reportFingerprint") != verified.get("reportFingerprint"):
        fail("Restore RTO drill report changed after verification")
    if record.get("startedAt", "") < rollback_started_at:
        return None
    staging_name = record.get("stagingName")
    candidate_set_id = record.get("candidateSetId")
    if not isinstance(staging_name, str) or not isinstance(candidate_set_id, str):
        return None
    return {
        "drillId": verified["drillId"],
        "reportPath": str(report_path),
        "reportFingerprint": verified["reportFingerprint"],
        "stagingName": staging_name,
        "candidateSetId": candidate_set_id,
        "reused": True,
    }


def find_verified_restore(
    report_root: Path,
    checker: Any,
    report_key: Path,
    bundle_name: str,
    bundle_sha256: str,
    rollback_started_at: str,
) -> dict[str, Any] | None:
    if not report_root.exists():
        return None
    if report_root.is_symlink() or not report_root.is_dir():
        fail("Restore RTO drill report root is unsafe")
    candidates = sorted(
        (path for path in report_root.glob("drill-*.json") if path.is_file() and not path.is_symlink()),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for report in candidates:
        match = parse_verified_report(report, checker, report_key, bundle_name, bundle_sha256, rollback_started_at)
        if match is not None:
            return match
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--journal-key", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--event-key", required=True, type=Path)
    parser.add_argument("--rollback-plan", required=True, type=Path)
    parser.add_argument("--rollback-plan-key", required=True, type=Path)
    parser.add_argument("--backup-root", required=True, type=Path)
    parser.add_argument("--restore-rto-report-root", required=True, type=Path)
    parser.add_argument("--restore-rto-report-key", required=True, type=Path)
    parser.add_argument("--restore-replay-root", required=True, type=Path)
    parser.add_argument("--restore-switch-journal-root", required=True, type=Path)
    parser.add_argument("--restore-promotion-key", required=True, type=Path)
    parser.add_argument("--rollback-receipt-dir", required=True, type=Path)
    parser.add_argument("--rollback-receipt-key", required=True, type=Path)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    update_dir = Path(__file__).resolve().parent
    backup_dir = repo_root / "infra" / "backup"
    harness = backup_dir / "run-club-restore-rto-drill.sh"
    report_checker_path = backup_dir / "check-restore-rto-drill-report.py"
    event_writer = update_dir / "persist-online-update-execution-event.py"
    receipt_writer = update_dir / "persist-online-update-rollback-receipt.py"

    try:
        for path, label in (
            (harness, "Restore RTO harness"),
            (report_checker_path, "Restore RTO report checker"),
            (event_writer, "Online update event writer"),
            (receipt_writer, "Online update rollback receipt writer"),
            (args.restore_rto_report_key, "Restore RTO report key"),
            (args.restore_promotion_key, "Restore promotion key"),
            (args.rollback_receipt_key, "Online update rollback receipt key"),
        ):
            ensure_regular(path, label)

        journal_module = load_module(update_dir / "persist-online-update-execution-journal.py", "md_update_journal")
        event_module = load_module(event_writer, "md_update_events")
        plan_module = load_module(update_dir / "persist-online-update-rollback-plan.py", "md_update_rollback_plan")
        receipt_module = load_module(receipt_writer, "md_update_rollback_receipt")
        report_checker = load_module(report_checker_path, "md_restore_rto_report_checker")

        journal = journal_module.verify_envelope(
            read_json(args.journal, "Online update execution journal"),
            journal_module.read_key(args.journal_key),
        )
        event_key = event_module.read_key(args.event_key)
        events = event_module.read_events(args.events_dir, event_key, journal)
        if not events:
            fail("Online update rollback executor requires execution events")

        plan = plan_module.verify_envelope(
            read_json(args.rollback_plan, "Online update rollback plan"),
            plan_module.read_key(args.rollback_plan_key),
        )
        plan_record = plan["record"]
        if plan_record.get("journalSignature") != journal["signature"]:
            fail("Rollback plan is bound to a different online update journal")

        receipt_path = args.rollback_receipt_dir / receipt_module.FILE_NAME
        latest = events[-1]
        latest_phase = latest["record"]["phase"]

        if latest_phase == "ROLLBACK_COMPLETED":
            receipt = receipt_module.verify_envelope(
                read_json(receipt_path, "Online update rollback receipt"),
                receipt_module.read_key(args.rollback_receipt_key),
            )
            event_module.verify_rollback_completion_receipt(
                receipt_path,
                args.rollback_receipt_key,
                journal,
                events,
            )
            completed = run(
                [
                    "python3", str(event_writer),
                    "--journal", str(args.journal),
                    "--journal-key", str(args.journal_key),
                    "--target-dir", str(args.events_dir),
                    "--key-file", str(args.event_key),
                    "--phase", "ROLLBACK_COMPLETED",
                    "--recorded-at", latest["record"]["recordedAt"],
                    "--rollback-receipt", str(receipt_path),
                    "--rollback-receipt-key", str(args.rollback_receipt_key),
                ],
                repo_root,
                COMMAND_TIMEOUT_SECONDS,
            )
            result = json.loads(completed.stdout.strip())
            print(json.dumps({
                "mode": "CLUB_ONLINE_UPDATE_ROLLBACK_EXECUTOR_V1",
                "status": "ROLLBACK_COMPLETED",
                "restoreReused": True,
                "receiptReused": True,
                "eventReused": result.get("eventReused") is True,
                "receiptSignature": receipt["signature"],
                "eventSignature": result.get("eventSignature"),
                "updateExecuted": False,
            }, separators=(",", ":")))
            return 0

        if latest_phase != "ROLLBACK_STARTED":
            fail("Online update rollback executor requires ROLLBACK_STARTED as latest event")
        if plan_record.get("rollbackStartedEventSignature") != latest["signature"]:
            fail("Rollback plan is not bound to the current ROLLBACK_STARTED event")

        anchor = plan_record["rollbackAnchor"]
        bundle_name = anchor["fileName"]
        bundle_path = args.backup_root / bundle_name
        ensure_regular(bundle_path, "Journal-bound pre-update backup")
        observed_sha = sha256_file(bundle_path)
        if observed_sha != anchor["sha256"]:
            fail("Journal-bound pre-update backup bytes no longer match rollback anchor")

        os.makedirs(Path(LOCK_FILE).parent, exist_ok=True)
        with open(LOCK_FILE, "a+", encoding="utf-8") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

            restore = find_verified_restore(
                args.restore_rto_report_root,
                report_checker,
                args.restore_rto_report_key,
                bundle_name,
                observed_sha,
                latest["record"]["recordedAt"],
            )
            if restore is None:
                run(["bash", str(harness), bundle_name], repo_root, RESTORE_TIMEOUT_SECONDS)
                restore = find_verified_restore(
                    args.restore_rto_report_root,
                    report_checker,
                    args.restore_rto_report_key,
                    bundle_name,
                    observed_sha,
                    latest["record"]["recordedAt"],
                )
                if restore is None:
                    fail("Restore harness completed without reusable verified restore evidence")
                restore["reused"] = False

            switch_intent = args.restore_replay_root / restore["stagingName"] / "promotion" / "switch" / "promotion-switch-intent.json"
            switch_execution_dir = args.restore_switch_journal_root / restore["candidateSetId"]
            switch_journal = switch_execution_dir / "promotion-switch-journal.json"
            ensure_regular(switch_intent, "Restore promotion switch intent")
            ensure_regular(switch_journal, "Restore promotion switch journal")

            if receipt_path.exists():
                receipt = receipt_module.verify_envelope(
                    read_json(receipt_path, "Online update rollback receipt"),
                    receipt_module.read_key(args.rollback_receipt_key),
                )
                receipt_created = False
            else:
                recorded_at = now_utc()
                receipt_result = run(
                    [
                        "python3", str(receipt_writer),
                        "--journal", str(args.journal),
                        "--journal-key", str(args.journal_key),
                        "--events-dir", str(args.events_dir),
                        "--event-key", str(args.event_key),
                        "--restore-switch-intent", str(switch_intent),
                        "--restore-switch-journal", str(switch_journal),
                        "--restore-switch-execution-dir", str(switch_execution_dir),
                        "--restore-promotion-key", str(args.restore_promotion_key),
                        "--target-dir", str(args.rollback_receipt_dir),
                        "--key-file", str(args.rollback_receipt_key),
                        "--recorded-at", recorded_at,
                    ],
                    repo_root,
                    COMMAND_TIMEOUT_SECONDS,
                )
                receipt_json = json.loads(receipt_result.stdout.strip())
                receipt_created = receipt_json.get("receiptCreated") is True
                receipt = receipt_module.verify_envelope(
                    read_json(receipt_path, "Online update rollback receipt"),
                    receipt_module.read_key(args.rollback_receipt_key),
                )

            event_module.verify_rollback_completion_receipt(
                receipt_path,
                args.rollback_receipt_key,
                journal,
                event_module.read_events(args.events_dir, event_key, journal),
            )
            event_result = run(
                [
                    "python3", str(event_writer),
                    "--journal", str(args.journal),
                    "--journal-key", str(args.journal_key),
                    "--target-dir", str(args.events_dir),
                    "--key-file", str(args.event_key),
                    "--phase", "ROLLBACK_COMPLETED",
                    "--recorded-at", now_utc(),
                    "--rollback-receipt", str(receipt_path),
                    "--rollback-receipt-key", str(args.rollback_receipt_key),
                ],
                repo_root,
                COMMAND_TIMEOUT_SECONDS,
            )
            event_json = json.loads(event_result.stdout.strip())

        print(json.dumps({
            "mode": "CLUB_ONLINE_UPDATE_ROLLBACK_EXECUTOR_V1",
            "status": "ROLLBACK_COMPLETED",
            "rollbackPlanSignature": plan["signature"],
            "rollbackBackupFileName": bundle_name,
            "rollbackBackupSha256": observed_sha,
            "restoreDrillId": restore["drillId"],
            "restoreReportFingerprint": restore["reportFingerprint"],
            "restoreReused": restore["reused"],
            "receiptCreated": receipt_created,
            "receiptSignature": receipt["signature"],
            "eventCreated": event_json.get("eventCreated") is True,
            "eventSignature": event_json.get("eventSignature"),
            "updateExecuted": False,
        }, separators=(",", ":")))
        return 0
    except BlockingIOError:
        print("Another online update rollback is already executing.", file=os.sys.stderr)
        return 1
    except (OSError, RollbackExecutorError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
