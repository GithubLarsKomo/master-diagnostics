#!/usr/bin/env python3
"""Evaluate the real global privacy policy against privacy values from a bound env file."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

PLAIN_ENV = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
PRIVACY_KEYS = (
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


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def read_privacy_env(path: Path) -> dict[str, str]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("RUNTIME_ENV_FILE_UNSAFE", "env file must be an absolute regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        fail("RUNTIME_ENV_PERMISSIONS_UNSAFE", "env file must not be group/world writable")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("RUNTIME_ENV_ENCODING_INVALID: env file must be UTF-8") from exc
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = PLAIN_ENV.fullmatch(line)
        if not match:
            if any(stripped.startswith(key) for key in PRIVACY_KEYS):
                fail("RUNTIME_PRIVACY_ENV_LINE_INVALID", "privacy variables must use plain KEY=VALUE syntax")
            continue
        key, value = match.group(1), match.group(2)
        if key not in PRIVACY_KEYS:
            continue
        if key in values:
            fail("RUNTIME_PRIVACY_ENV_DUPLICATE", f"privacy variable {key} occurs more than once")
        values[key] = value
    if "PRIVACY_BACKUP_STATE" not in values or "PRIVACY_NOTIFICATIONS_STATE" not in values:
        fail("RUNTIME_PRIVACY_STATE_MISSING", "backup and notification privacy states must both be declared")
    return values


def evaluate(repo_root: Path, env_file: Path, expected_backup_state: str) -> dict[str, Any]:
    if not repo_root.is_absolute() or repo_root.is_symlink() or not repo_root.is_dir():
        fail("RUNTIME_REPO_ROOT_UNSAFE", "repo root must be an absolute regular non-symlink directory")
    if expected_backup_state not in ("DISABLED", "ENABLED"):
        fail("RUNTIME_EXPECTED_BACKUP_STATE_INVALID", "expected backup state must be DISABLED or ENABLED")
    values = read_privacy_env(env_file)
    child_env = dict(os.environ)
    for key in PRIVACY_KEYS:
        child_env.pop(key, None)
    child_env.update(values)
    proc = subprocess.run(
        ["pnpm", "--silent", "--filter", "@masters/db", "privacy-capabilities:check"],
        cwd=repo_root,
        env=child_env,
        check=False,
        capture_output=True,
        text=True,
    )
    stdout = proc.stdout.strip()
    if not stdout:
        fail("RUNTIME_PRIVACY_CHECK_OUTPUT_MISSING", "privacy-capabilities:check produced no JSON output")
    try:
        result = json.loads(stdout.splitlines()[-1])
    except json.JSONDecodeError as exc:
        raise ValueError("RUNTIME_PRIVACY_CHECK_OUTPUT_INVALID: privacy-capabilities:check did not return JSON") from exc
    if not isinstance(result, dict):
        fail("RUNTIME_PRIVACY_CHECK_OUTPUT_INVALID", "privacy-capabilities:check output must be a JSON object")
    normalized = {
        "readyForIrreversibleProcessing": result.get("readyForIrreversibleProcessing"),
        "backupState": result.get("backupState"),
        "notificationsState": result.get("notificationsState"),
        "backupPolicyVersion": result.get("backupPolicyVersion"),
        "notificationPolicyVersion": result.get("notificationPolicyVersion"),
        "blockers": result.get("blockers"),
    }
    if proc.returncode != 0 or normalized["readyForIrreversibleProcessing"] is not True:
        fail("RUNTIME_PRIVACY_NOT_READY", "global privacy capability evaluation is not ready")
    if normalized["backupState"] != expected_backup_state:
        fail("RUNTIME_BACKUP_STATE_MISMATCH", "runtime backup state does not match expected state")
    if expected_backup_state == "ENABLED" and normalized["backupPolicyVersion"] != "1.0.0":
        fail("RUNTIME_BACKUP_POLICY_MISMATCH", "enabled backup state must attest policy version 1.0.0")
    if normalized["blockers"] != []:
        fail("RUNTIME_PRIVACY_BLOCKERS_PRESENT", "runtime privacy evaluation still has blockers")
    return {
        "mode": "BACKUP_PRIVACY_RUNTIME_ENV_ATTESTATION",
        "status": "RUNTIME_PRIVACY_VERIFIED",
        "expectedBackupState": expected_backup_state,
        **normalized,
        "attestationFingerprint": sha256_json(normalized),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--expected-backup-state", required=True, choices=("DISABLED", "ENABLED"))
    args = parser.parse_args()
    try:
        print(json.dumps(evaluate(args.repo_root, args.env_file, args.expected_backup_state), separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_RUNTIME_ENV_ATTESTATION",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "expectedBackupState": args.expected_backup_state,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
