#!/usr/bin/env python3
"""Verify a signed backup-privacy service cutover plan without mutating services."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

SIGNING_DOMAIN = b"masters:backup-privacy-service-cutover-plan:v1\n"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256 = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CUTOVER_ID = re.compile(r"^cutover-[0-9a-f]{32}$")
TARGET = {
    "PRIVACY_BACKUP_STATE": "ENABLED",
    "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
    "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
    "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
    "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
}
PREFLIGHT_SERVICE = "privacy-check"
RECREATE_SERVICES = ["app", "export-cleanup", "retention-scan"]
PRESERVE_SERVICES = ["libsql", "caddy"]


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_file(path: Path, code: str, private: bool = False) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{code}_UNSAFE", "file must be an absolute regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o022:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must not be group/world writable")
    if private and mode & 0o077:
        fail(f"{code}_PERMISSIONS_UNSAFE", "file must be private")
    return path.read_bytes()


def read_key(path: Path) -> bytes:
    raw = read_file(path, "SERVICE_CUTOVER_KEY", private=True)
    try:
        key = base64.b64decode(raw.decode("utf-8").strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("SERVICE_CUTOVER_KEY_INVALID: invalid Base64") from exc
    if len(key) != 32:
        fail("SERVICE_CUTOVER_KEY_INVALID", "key must decode to exactly 32 bytes")
    return key


def run_json(command: list[str]) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(command, check=False, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("SERVICE_CUTOVER_DEPENDENCY_OUTPUT_INVALID: dependency did not return JSON") from exc
    if not isinstance(result, dict):
        fail("SERVICE_CUTOVER_DEPENDENCY_OUTPUT_INVALID", "dependency output must be an object")
    return proc.returncode, result


def verify_completion(args: argparse.Namespace) -> dict[str, Any]:
    code, result = run_json([
        sys.executable, str(args.completion_checker),
        "--plan-checker", str(args.plan_checker),
        "--evidence-checker", str(args.evidence_checker),
        "--plan", str(args.activation_plan),
        "--pending", str(args.pending),
        "--completion", str(args.completion),
        "--key-file", str(args.key_file),
        "--env-file", str(args.env_file),
    ])
    if code != 0 or result.get("status") != "ACTIVATION_COMPLETION_VERIFIED":
        fail("ACTIVATION_COMPLETION_NOT_VERIFIED", f"completion verification failed: {result.get('blocker')}")
    return result


def rendered_compose_sha(compose_file: Path, env_file: Path) -> str:
    read_file(compose_file, "SERVICE_CUTOVER_COMPOSE")
    read_file(env_file, "ENV_FILE", private=True)
    proc = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(compose_file), "config", "--format", "json"],
        check=False, capture_output=True,
    )
    if proc.returncode != 0:
        fail("SERVICE_CUTOVER_COMPOSE_RENDER_FAILED", proc.stderr.decode("utf-8", errors="replace")[:200])
    try:
        rendered = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("SERVICE_CUTOVER_COMPOSE_RENDER_INVALID: compose config did not return JSON") from exc
    if not isinstance(rendered, dict):
        fail("SERVICE_CUTOVER_COMPOSE_RENDER_INVALID", "rendered compose must be an object")
    return sha256_bytes((canonical_json(rendered) + "\n").encode("utf-8"))


def expected_signature(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def validate_record(record: dict[str, Any], args: argparse.Namespace, completion: dict[str, Any]) -> None:
    if record.get("serviceCutoverPlanVersion") != 1:
        fail("SERVICE_CUTOVER_PLAN_VERSION_INVALID", "plan version must be 1")
    cutover_id = record.get("cutoverId")
    if not isinstance(cutover_id, str) or not CUTOVER_ID.fullmatch(cutover_id):
        fail("SERVICE_CUTOVER_ID_INVALID", "cutover ID is invalid")
    expected_paths = {
        "activationPlanPath": str(args.activation_plan),
        "pendingEvidencePath": str(args.pending),
        "completionPath": str(args.completion),
        "envFilePath": str(args.env_file),
        "composeFilePath": str(args.compose_file),
    }
    for field, expected in expected_paths.items():
        if record.get(field) != expected:
            fail("SERVICE_CUTOVER_PATH_BINDING_MISMATCH", f"{field} does not match requested path")
    expected_hashes = {
        "activationPlanFileSha256": sha256_bytes(read_file(args.activation_plan, "ACTIVATION_PLAN", private=True)),
        "pendingEvidenceFileSha256": sha256_bytes(read_file(args.pending, "ACTIVATION_PENDING", private=True)),
        "completionFileSha256": sha256_bytes(read_file(args.completion, "ACTIVATION_COMPLETION", private=True)),
        "composeFileSha256": sha256_bytes(read_file(args.compose_file, "SERVICE_CUTOVER_COMPOSE")),
        "renderedComposeSha256": rendered_compose_sha(args.compose_file, args.env_file),
    }
    for field, expected in expected_hashes.items():
        if record.get(field) != expected:
            fail("SERVICE_CUTOVER_ARTIFACT_DRIFT", f"{field} no longer matches signed plan")
    completion_expected = {
        "activationId": completion.get("activationId"),
        "executionId": completion.get("executionId"),
        "completionFingerprint": completion.get("completionFingerprint"),
        "completionFileSha256": completion.get("completionFileSha256"),
        "targetEnvFingerprint": completion.get("targetEnvFingerprint"),
        "configurationRuntimeAttestationSha256": completion.get("runtimeAttestationSha256"),
    }
    for field, expected in completion_expected.items():
        if record.get(field) != expected:
            fail("SERVICE_CUTOVER_COMPLETION_BINDING_MISMATCH", f"{field} differs from verified completion")
    if record.get("preflightService") != PREFLIGHT_SERVICE or record.get("recreateServices") != RECREATE_SERVICES or record.get("preserveServices") != PRESERVE_SERVICES:
        fail("SERVICE_CUTOVER_SERVICE_POLICY_INVALID", "service policy differs from v1 contract")
    if record.get("requiredPrivacyEnvironment") != TARGET:
        fail("SERVICE_CUTOVER_PRIVACY_TARGET_INVALID", "required privacy environment differs from policy v1")
    for field in (
        "preflightMustSucceedBeforeMutation",
        "renderedComposeMustRemainBound",
        "caddyContainerMustBePreserved",
        "libsqlContainerMustBePreserved",
        "appHealthcheckRequired",
        "backgroundServicesRunningRequired",
        "liveRuntimeEnvironmentAttestationRequired",
        "rollbackOnCutoverFailureRequired",
    ):
        if record.get(field) is not True:
            fail("SERVICE_CUTOVER_POLICY_INVALID", f"{field} must be true")
    if record.get("serviceCutoverExecuted") is not False or record.get("liveRuntimeAttested") is not False:
        fail("SERVICE_CUTOVER_PLAN_BOUNDARY_INVALID", "plan must remain pre-mutation")
    fingerprint = record.get("cutoverPlanFingerprint")
    if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
        fail("SERVICE_CUTOVER_PLAN_FINGERPRINT_INVALID", "plan fingerprint is invalid")
    body = dict(record); body.pop("cutoverPlanFingerprint")
    if not hmac.compare_digest(fingerprint, sha256_bytes(canonical_json(body).encode("utf-8"))):
        fail("SERVICE_CUTOVER_PLAN_FINGERPRINT_MISMATCH", "plan fingerprint does not match record")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--completion-checker", required=True, type=Path)
    parser.add_argument("--plan-checker", required=True, type=Path)
    parser.add_argument("--evidence-checker", required=True, type=Path)
    parser.add_argument("--activation-plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--completion", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--cutover-plan", required=True, type=Path)
    args = parser.parse_args()
    try:
        key = read_key(args.key_file)
        completion = verify_completion(args)
        raw = read_file(args.cutover_plan, "SERVICE_CUTOVER_PLAN", private=True)
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("SERVICE_CUTOVER_PLAN_INVALID: plan is not JSON") from exc
        if not isinstance(envelope, dict) or envelope.get("envelopeVersion") != 1 or not isinstance(envelope.get("record"), dict):
            fail("SERVICE_CUTOVER_PLAN_INVALID", "plan envelope is invalid")
        record = envelope["record"]
        validate_record(record, args, completion)
        signature = envelope.get("signature")
        if not isinstance(signature, str) or not HMAC_SHA256.fullmatch(signature):
            fail("SERVICE_CUTOVER_PLAN_SIGNATURE_INVALID", "plan signature is invalid")
        if not hmac.compare_digest(signature, expected_signature(record, key)):
            fail("SERVICE_CUTOVER_PLAN_SIGNATURE_MISMATCH", "plan HMAC does not match")
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN_VERIFICATION",
            "status": "SERVICE_CUTOVER_PLAN_VERIFIED",
            "cutoverId": record["cutoverId"],
            "activationId": record["activationId"],
            "cutoverPlanFingerprint": record["cutoverPlanFingerprint"],
            "renderedComposeSha256": record["renderedComposeSha256"],
            "serviceCutoverExecutionAllowed": True,
            "serviceCutoverExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        blocker = str(exc).split(":", 1)[0]
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN_VERIFICATION",
            "status": "BLOCKED",
            "blocker": blocker,
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
        }, separators=(",", ":"), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
