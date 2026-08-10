#!/usr/bin/env python3
"""Resolve immutable online-update image references without pulling image layers."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

ENVELOPE_VERSION = 1
RESOLUTION_VERSION = 1
SIGNING_DOMAIN = b"masters:club-online-update-image-resolution:v1\n"
FILE_NAME = "online-update-image-resolution.json"
HMAC_PATTERN = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE_PATTERN = re.compile(r"^(?P<registry>[a-z0-9.-]+(?::[0-9]+)?)/(?P<path>[a-z0-9._/-]+)@(?P<digest>sha256:[0-9a-f]{64})$")
LOCAL_REGISTRIES = {"localhost", "127.0.0.1"}


class ResolutionError(ValueError):
    pass


def fail(message: str) -> None:
    raise ResolutionError(message)


def load_preparation_module():
    path = Path(__file__).with_name("persist-online-update-preparation.py")
    spec = importlib.util.spec_from_file_location("master_diagnostics_online_update_preparation", path)
    if spec is None or spec.loader is None:
        fail("Unable to load online update preparation module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_regular_json(path: Path, label: str) -> Any:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ResolutionError(f"{label} is not valid JSON") from exc


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("Online update image-resolution key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except (ValueError, OSError) as exc:
        raise ResolutionError("Online update image-resolution key is not valid base64") from exc
    if len(key) != 32:
        fail("Online update image-resolution key must decode to exactly 32 bytes")
    return key


def ensure_target_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("Online update image-resolution target directory must be absolute")
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        fail("Online update image-resolution target must be a non-symlink directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("Online update image-resolution target must be a non-symlink directory")
    os.chmod(path, 0o700)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_record(key: bytes, record: dict[str, Any]) -> str:
    payload = SIGNING_DOMAIN + canonical_json({"envelopeVersion": 1, "record": record}).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, payload, hashlib.sha256).hexdigest()


def registry_host(reference: str) -> str:
    match = IMAGE_PATTERN.fullmatch(reference)
    if not match:
        fail("Online update image reference is not an immutable sha256 registry reference")
    return match.group("registry").split(":", 1)[0]


def expected_digest(reference: str) -> str:
    match = IMAGE_PATTERN.fullmatch(reference)
    if not match:
        fail("Online update image reference is not an immutable sha256 registry reference")
    return match.group("digest")


def inspect_manifest(reference: str, allow_insecure_localhost: bool) -> dict[str, Any]:
    host = registry_host(reference)
    command = ["docker", "manifest", "inspect", "--verbose"]
    if allow_insecure_localhost:
        if host not in LOCAL_REGISTRIES:
            fail("Insecure registry inspection is allowed only for localhost or 127.0.0.1")
        command.append("--insecure")
    command.append(reference)
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ResolutionError("Docker manifest inspection could not be executed") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ResolutionError(f"Registry manifest inspection failed for immutable reference: {detail}")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ResolutionError("Docker manifest inspection returned invalid JSON") from exc
    if not isinstance(value, dict):
        fail("Docker manifest inspection returned an unsupported result")
    descriptor = value.get("Descriptor")
    if not isinstance(descriptor, dict):
        fail("Docker manifest inspection did not return a descriptor")
    digest = descriptor.get("digest")
    if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
        fail("Docker manifest inspection descriptor digest is invalid")
    expected = expected_digest(reference)
    if digest != expected:
        fail("Registry descriptor digest does not match immutable selected reference")
    media_type = descriptor.get("mediaType")
    size = descriptor.get("size")
    if not isinstance(media_type, str) or not media_type:
        fail("Registry descriptor media type is invalid")
    if not isinstance(size, int) or size <= 0:
        fail("Registry descriptor size is invalid")
    return {"reference": reference, "digest": digest, "mediaType": media_type, "size": size, "available": True}


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("Online update image-resolution record is invalid")
    expected = {
        "resolutionVersion", "phase", "preparationSignature", "manifestFingerprint",
        "targetVersion", "images", "allImmutableReferencesAvailable", "descriptorDigestsMatch",
        "imagePullAllowed", "migrationAllowed", "productionMutationAllowed", "updateExecuted",
    }
    if set(record) != expected:
        fail("Online update image-resolution fields do not exactly match v1 contract")
    if record.get("resolutionVersion") != 1 or record.get("phase") != "RESOLVED":
        fail("Online update image-resolution version or phase is invalid")
    if not isinstance(record.get("preparationSignature"), str) or not HMAC_PATTERN.fullmatch(record["preparationSignature"]):
        fail("Online update image-resolution preparation signature is invalid")
    if not isinstance(record.get("manifestFingerprint"), str) or not SHA256_PATTERN.fullmatch(record["manifestFingerprint"]):
        fail("Online update image-resolution manifest fingerprint is invalid")
    images = record.get("images")
    if not isinstance(images, list) or [item.get("role") if isinstance(item, dict) else None for item in images] != ["APP", "MIGRATOR"]:
        fail("Online update image-resolution role binding is invalid")
    for item in images:
        if set(item) != {"role", "reference", "digest", "mediaType", "size", "available"}:
            fail("Online update image-resolution descriptor fields are invalid")
        if item.get("available") is not True or item.get("digest") != expected_digest(item.get("reference", "")):
            fail("Online update image-resolution descriptor binding is invalid")
        if not isinstance(item.get("mediaType"), str) or not isinstance(item.get("size"), int) or item["size"] <= 0:
            fail("Online update image-resolution descriptor metadata is invalid")
    required_flags = {
        "allImmutableReferencesAvailable": True,
        "descriptorDigestsMatch": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }
    for field, wanted in required_flags.items():
        if record.get(field) is not wanted:
            fail(f"Online update image-resolution safety flag {field} is invalid")
    return record


def verify_envelope(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        fail("Online update image-resolution envelope version is invalid")
    record = validate_record(value.get("record"))
    signature = value.get("signature")
    if not isinstance(signature, str) or not HMAC_PATTERN.fullmatch(signature):
        fail("Online update image-resolution signature is invalid")
    if not hmac.compare_digest(signature, sign_record(key, record)):
        fail("Online update image-resolution signature verification failed")
    return {"envelopeVersion": 1, "record": record, "signature": signature}


def persist(target_dir: Path, key: bytes, record: dict[str, Any]) -> tuple[Path, bool, dict[str, Any]]:
    ensure_target_dir(target_dir)
    path = target_dir / FILE_NAME
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("Online update image-resolution evidence is not a regular non-symlink file")
        existing = verify_envelope(read_regular_json(path, "Online update image-resolution evidence"), key)
        if existing["record"] != record:
            fail("Existing online update image resolution does not match current registry evidence")
        return path, False, existing
    record = validate_record(record)
    envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(key, record)}
    serialized = json.dumps(envelope, indent=2, ensure_ascii=False) + "\n"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return persist(target_dir, key, record)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    os.chmod(path, 0o600)
    return path, True, envelope


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preparation", required=True, type=Path)
    parser.add_argument("--preparation-key", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--allow-insecure-localhost", action="store_true")
    args = parser.parse_args()
    try:
        prep_module = load_preparation_module()
        prep_key = prep_module.read_key(args.preparation_key)
        preparation = prep_module.verify_envelope(read_regular_json(args.preparation, "Online update preparation"), prep_key)
        prep_record = preparation["record"]
        descriptors = []
        for source in prep_record["images"]:
            descriptor = inspect_manifest(source["reference"], args.allow_insecure_localhost)
            descriptors.append({"role": source["role"], **descriptor})
        record = {
            "resolutionVersion": 1,
            "phase": "RESOLVED",
            "preparationSignature": preparation["signature"],
            "manifestFingerprint": prep_record["manifestFingerprint"],
            "targetVersion": prep_record["targetVersion"],
            "images": descriptors,
            "allImmutableReferencesAvailable": True,
            "descriptorDigestsMatch": True,
            "imagePullAllowed": False,
            "migrationAllowed": False,
            "productionMutationAllowed": False,
            "updateExecuted": False,
        }
        key = read_key(args.key_file)
        path, created, envelope = persist(args.target_dir, key, record)
    except (OSError, ResolutionError, ValueError) as exc:
        print(str(exc), file=os.sys.stderr)
        return 1
    print(canonical_json({
        "mode": "CLUB_ONLINE_UPDATE_IMAGE_RESOLUTION_V1",
        "status": "READY_FOR_UPDATE_EXECUTION_PLAN",
        "resolutionPath": str(path),
        "resolutionCreated": created,
        "resolutionReused": not created,
        "preparationSignature": envelope["record"]["preparationSignature"],
        "images": envelope["record"]["images"],
        "allImmutableReferencesAvailable": True,
        "descriptorDigestsMatch": True,
        "imagePullAllowed": False,
        "migrationAllowed": False,
        "productionMutationAllowed": False,
        "updateExecuted": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
