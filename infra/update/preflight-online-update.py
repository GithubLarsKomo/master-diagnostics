#!/usr/bin/env python3
"""Fail-closed, read-only preflight for an explicitly selected online update."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE = re.compile(r"^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$")
RELEASE_ROLES = ("APP", "MIGRATOR")


class PreflightError(ValueError):
    pass


def fail(message: str) -> None:
    raise PreflightError(message)


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_absolute():
        fail("Update manifest path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail("Update manifest must be a regular non-symlink file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PreflightError("Update manifest is not valid JSON") from exc
    if not isinstance(value, dict):
        fail("Update manifest must be a JSON object")
    return value


def parse_semver(value: Any, label: str) -> tuple[int, int, int, str | None]:
    if not isinstance(value, str):
        fail(f"{label} must be a semantic version")
    match = SEMVER.fullmatch(value)
    if not match:
        fail(f"{label} must be a semantic version")
    major, minor, patch, prerelease = match.groups()
    return int(major), int(minor), int(patch), prerelease


def ensure_upgrade(current: str, target: str) -> None:
    current_parsed = parse_semver(current, "Current version")
    target_parsed = parse_semver(target, "Target version")
    current_core = current_parsed[:3]
    target_core = target_parsed[:3]
    if target_core < current_core:
        fail("Online update preflight refuses a version downgrade")
    if target_core == current_core:
        if current_parsed[3] == target_parsed[3]:
            fail("Online update target must differ from the current version")
        if current_parsed[3] is None:
            fail("Online update preflight refuses moving from a stable release to a prerelease")
        if target_parsed[3] is not None and target_parsed[3] <= current_parsed[3]:
            fail("Online update target prerelease must be newer than the current prerelease")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def manifest_fingerprint(manifest: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()


def validate_release_notes(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        fail("Release notes metadata is required")
    title = value.get("title")
    url = value.get("url")
    digest = value.get("sha256")
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        fail("Release notes title is invalid")
    if not isinstance(url, str):
        fail("Release notes URL is required")
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        fail("Release notes URL must be an absolute HTTPS URL without credentials")
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        fail("Release notes SHA-256 fingerprint is invalid")
    return {"title": title, "url": url, "sha256": digest}


def validate_images(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or len(value) != len(RELEASE_ROLES):
        fail("Online update manifest must contain exactly APP and MIGRATOR images")
    normalized: list[dict[str, str]] = []
    seen_roles: set[str] = set()
    seen_refs: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            fail("Online update image entry is invalid")
        role = item.get("role")
        reference = item.get("reference")
        if role not in RELEASE_ROLES:
            fail("Online update image role is invalid")
        if not isinstance(reference, str) or not IMAGE.fullmatch(reference):
            fail(f"Online update {role} image must use an immutable registry digest reference")
        if role in seen_roles:
            fail("Online update image roles must be unique")
        if reference in seen_refs:
            fail("Online update APP and MIGRATOR image references must be distinct")
        seen_roles.add(role)
        seen_refs.add(reference)
        normalized.append({"role": role, "reference": reference})
    if seen_roles != set(RELEASE_ROLES):
        fail("Online update manifest must bind APP and MIGRATOR image roles")
    return sorted(normalized, key=lambda item: RELEASE_ROLES.index(item["role"]))


def validate_manifest(manifest: dict[str, Any], current_version: str) -> dict[str, Any]:
    allowed_keys = {
        "manifestVersion",
        "channel",
        "releaseVersion",
        "releaseNotes",
        "images",
        "migrationPolicy",
        "backupPolicy",
        "rollbackPolicy",
        "autoUpdate",
    }
    if set(manifest) != allowed_keys:
        fail("Online update manifest fields do not exactly match v1 contract")
    if manifest.get("manifestVersion") != 1:
        fail("Online update manifest version is invalid")
    if manifest.get("channel") != "stable":
        fail("Online update preflight currently accepts only the stable channel")
    target_version = manifest.get("releaseVersion")
    if not isinstance(target_version, str):
        fail("Target version is missing")
    ensure_upgrade(current_version, target_version)
    release_notes = validate_release_notes(manifest.get("releaseNotes"))
    images = validate_images(manifest.get("images"))
    if manifest.get("migrationPolicy") != "CONTROLLED_MIGRATIONS_BEFORE_APP_START":
        fail("Online update migration policy is invalid")
    if manifest.get("backupPolicy") != "VERIFIED_PREUPDATE_BACKUP_REQUIRED":
        fail("Online update backup policy is invalid")
    if manifest.get("rollbackPolicy") != "RESTORE_VERIFIED_PREUPDATE_BACKUP":
        fail("Online update rollback policy is invalid")
    if manifest.get("autoUpdate") is not False:
        fail("Unattended automatic online updates are forbidden")

    return {
        "mode": "CLUB_ONLINE_UPDATE_PREFLIGHT_V1",
        "status": "READY_FOR_VERIFIED_BACKUP",
        "manifestVersion": 1,
        "manifestFingerprint": manifest_fingerprint(manifest),
        "currentVersion": current_version,
        "targetVersion": target_version,
        "channel": "stable",
        "releaseNotes": release_notes,
        "images": images,
        "migrationPolicy": "CONTROLLED_MIGRATIONS_BEFORE_APP_START",
        "backupPolicy": "VERIFIED_PREUPDATE_BACKUP_REQUIRED",
        "rollbackPolicy": "RESTORE_VERIFIED_PREUPDATE_BACKUP",
        "operatorSelectionRequired": True,
        "verifiedBackupRequiredBeforeMutation": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "autoUpdateAllowed": False,
        "updateExecuted": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--current-version", required=True)
    args = parser.parse_args()
    try:
        result = validate_manifest(read_json(args.manifest), args.current_version)
    except (OSError, PreflightError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
