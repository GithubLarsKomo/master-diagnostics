#!/usr/bin/env python3
"""Prepare a signed, non-mutating backup-privacy runtime activation plan."""
from __future__ import annotations

import argparse, base64, hashlib, hmac, json, os, re, stat, subprocess, sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-activation-plan:v1\n"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
ATTESTATION_ID = re.compile(r"^attestation-[0-9a-f]{32}$")
TARGET_ORDER = (
    "PRIVACY_BACKUP_STATE",
    "PRIVACY_BACKUP_POLICY_VERSION",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION",
)
TARGET = {
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


def read_key(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ACTIVATION_PLAN_KEY_UNSAFE", "activation plan key must be an absolute regular non-symlink file")
    try:
        key = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("ACTIVATION_PLAN_KEY_INVALID: key is not valid Base64") from exc
    if len(key) != 32:
        fail("ACTIVATION_PLAN_KEY_INVALID", "activation plan key must decode to exactly 32 bytes")
    return key


def read_env(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("ENV_FILE_UNSAFE", "env file must be an absolute regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o022:
        fail("ENV_FILE_PERMISSIONS_UNSAFE", "env file must not be group/world writable")
    return path.read_bytes()


def build_target_env(raw: bytes) -> tuple[bytes, dict[str, str]]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("ENV_FILE_ENCODING_INVALID: env file must be UTF-8") from exc
    lines = text.splitlines()
    seen: dict[str, int] = {}
    values: dict[str, str] = {}
    parsed = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
    for idx, line in enumerate(lines):
        match = parsed.fullmatch(line)
        if not match:
            for key in TARGET_ORDER:
                if line.lstrip().startswith(key):
                    fail("ENV_TARGET_LINE_INVALID", f"target variable {key} must use plain KEY=VALUE syntax")
            continue
        key, value = match.group(1), match.group(2)
        if key in TARGET:
            if key in seen:
                fail("ENV_TARGET_DUPLICATE", f"target variable {key} occurs more than once")
            seen[key] = idx
            values[key] = value
    if values.get("PRIVACY_BACKUP_STATE") != "DISABLED":
        fail("BACKUP_CAPABILITY_NOT_DISABLED", "activation planning requires PRIVACY_BACKUP_STATE=DISABLED")

    result = list(lines)
    for key in TARGET_ORDER:
        replacement = f"{key}={TARGET[key]}"
        if key in seen:
            result[seen[key]] = replacement
        else:
            result.append(replacement)
    return ("\n".join(result) + "\n").encode("utf-8"), values


def verify_attestation(checker: Path, attestation: Path, key_file: Path) -> dict[str, Any]:
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("ATTESTATION_CHECKER_UNSAFE", "attestation checker must be an absolute regular non-symlink file")
    proc = subprocess.run(
        [sys.executable, str(checker), "--attestation", str(attestation), "--key-file", str(key_file)],
        check=False, capture_output=True, text=True,
    )
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ATTESTATION_CHECK_OUTPUT_INVALID: attestation checker did not return JSON") from exc
    if proc.returncode != 0 or result.get("status") != "ATTESTATION_VERIFIED":
        fail("ATTESTATION_NOT_VERIFIED", f"manual attestation verification failed: {result.get('blocker')}")
    if result.get("privacyBackupActivationAllowed") is not True:
        fail("ATTESTATION_NOT_AUTHORIZING", "manual attestation does not authorize activation")
    if result.get("activationTarget") != TARGET:
        fail("ATTESTATION_TARGET_MISMATCH", "manual attestation target does not match policy v1")
    if result.get("runtimeConfigurationChanged") is not False:
        fail("ATTESTATION_BOUNDARY_INVALID", "manual attestation must precede runtime mutation")
    return result


def safe_output_dir(path: Path) -> None:
    if not path.is_absolute():
        fail("ACTIVATION_PLAN_OUTPUT_NOT_ABSOLUTE", "plan output directory must be absolute")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        fail("ACTIVATION_PLAN_OUTPUT_UNSAFE", "plan output directory must be a regular directory")
    os.chmod(path, 0o700)


def make_record(env_path: Path, raw: bytes, target_raw: bytes, attestation_path: Path, att: dict[str, Any]) -> dict[str, Any]:
    attestation_id = att.get("attestationId")
    attestation_fp = att.get("attestationFingerprint")
    if not isinstance(attestation_id, str) or not ATTESTATION_ID.fullmatch(attestation_id):
        fail("ATTESTATION_ID_INVALID", "verified attestation ID is invalid")
    if not isinstance(attestation_fp, str) or not SHA256.fullmatch(attestation_fp):
        fail("ATTESTATION_FINGERPRINT_INVALID", "verified attestation fingerprint is invalid")
    binding = {
        "attestationId": attestation_id,
        "attestationFingerprint": attestation_fp,
        "attestationFileSha256": sha256_bytes(attestation_path.read_bytes()),
        "envFilePath": str(env_path),
        "currentEnvFingerprint": sha256_bytes(raw),
        "targetEnvFingerprint": sha256_bytes(target_raw),
        "activationTarget": TARGET,
    }
    activation_id = "activation-" + hashlib.sha256(canonical_json(binding).encode()).hexdigest()[:32]
    record: dict[str, Any] = {
        "activationPlanVersion": 1,
        "activationId": activation_id,
        **binding,
        "expectedPreState": "DISABLED",
        "expectedPostState": "ENABLED",
        "atomicReplaceRequired": True,
        "postWriteRuntimeAttestationRequired": True,
        "rollbackOnValidationFailureRequired": True,
        "runtimeConfigurationChanged": False,
        "activationExecuted": False,
    }
    record["planFingerprint"] = "sha256:" + hashlib.sha256(canonical_json(record).encode()).hexdigest()
    return record


def sign_record(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode(), hashlib.sha256).hexdigest()


def persist(output_dir: Path, envelope: dict[str, Any]) -> tuple[Path, bool]:
    path = output_dir / f"{envelope['record']['activationId']}.json"
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        if path.is_symlink() or not path.is_file():
            fail("ACTIVATION_PLAN_FILE_UNSAFE", "existing plan path is unsafe")
        if path.read_text(encoding="utf-8") == serialized:
            return path, False
        fail("ACTIVATION_PLAN_CONFLICT", "activation plan already exists with different content")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    return path, True


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--attestation-checker", required=True, type=Path)
    p.add_argument("--attestation", required=True, type=Path)
    p.add_argument("--key-file", required=True, type=Path)
    p.add_argument("--env-file", required=True, type=Path)
    p.add_argument("--output-dir", required=True, type=Path)
    args = p.parse_args()
    try:
        att = verify_attestation(args.attestation_checker, args.attestation, args.key_file)
        raw = read_env(args.env_file)
        target_raw, _ = build_target_env(raw)
        safe_output_dir(args.output_dir)
        key = read_key(args.key_file)
        record = make_record(args.env_file, raw, target_raw, args.attestation, att)
        envelope = {"envelopeVersion": 1, "record": record, "signature": sign_record(record, key)}
        path, created = persist(args.output_dir, envelope)
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_ACTIVATION_PLAN",
            "status": "ACTIVATION_PLAN_READY",
            "activationId": record["activationId"],
            "planFingerprint": record["planFingerprint"],
            "currentEnvFingerprint": record["currentEnvFingerprint"],
            "targetEnvFingerprint": record["targetEnvFingerprint"],
            "planPath": str(path),
            "planCreated": created,
            "planReused": not created,
            "runtimeConfigurationChanged": False,
            "activationExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
