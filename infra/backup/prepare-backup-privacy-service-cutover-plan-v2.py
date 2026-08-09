#!/usr/bin/env python3
"""Prepare signed service cutover plan v2 from TARGET_HANDOFF_VERIFIED evidence."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

PLAN_VERSION = 2
SIGNING_DOMAIN = b"masters:backup-privacy-service-cutover-plan:v2\n"
ACTIVATION_ID = re.compile(r"^activation-[0-9a-f]{32}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_v1(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("SERVICE_CUTOVER_V1_MODULE_UNSAFE", "v1 planner module is unsafe")
    spec = importlib.util.spec_from_file_location("service_cutover_plan_v1", path)
    if spec is None or spec.loader is None:
        fail("SERVICE_CUTOVER_V1_MODULE_INVALID", "cannot import v1 planner module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("read_key", "read_file", "render_compose", "validate_rendered_compose", "safe_output_root", "persist", "sha256_bytes", "TARGET", "PREFLIGHT_SERVICE", "RECREATE_SERVICES", "PRESERVE_SERVICES"):
        if not hasattr(module, name):
            fail("SERVICE_CUTOVER_V1_MODULE_INVALID", f"missing helper {name}")
    return module


def run_json(command: list[str]) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(command, check=False, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("TARGET_HANDOFF_CHECK_OUTPUT_INVALID: checker did not return JSON") from exc
    if not isinstance(result, dict):
        fail("TARGET_HANDOFF_CHECK_OUTPUT_INVALID", "checker output must be a JSON object")
    return proc.returncode, result


def verify_handoff(args: argparse.Namespace) -> dict[str, Any]:
    checker = args.handoff_checker
    if not checker.is_absolute() or checker.is_symlink() or not checker.is_file():
        fail("TARGET_HANDOFF_CHECKER_UNSAFE", "target handoff checker is unsafe")
    code, result = run_json([
        sys.executable, str(checker),
        "--plan", str(args.activation_plan),
        "--pending", str(args.pending),
        "--handoff", str(args.handoff),
        "--key-file", str(args.key_file),
        "--env-file", str(args.env_file),
    ])
    if code != 0 or result.get("status") != "TARGET_HANDOFF_VERIFIED" or result.get("serviceCutoverPlanningAllowed") is not True:
        fail("TARGET_HANDOFF_NOT_VERIFIED", f"target handoff failed: {result.get('blocker')}")
    if result.get("serviceCutoverExecuted") is not False or result.get("liveRuntimeAttested") is not False or result.get("activationExecuted") is not False:
        fail("TARGET_HANDOFF_SCOPE_INVALID", "service planning requires nonterminal pre-runtime handoff")
    return result


def sign(record: dict[str, Any], key: bytes) -> str:
    payload = {"envelopeVersion": 1, "record": record}
    return "hmac-sha256:" + hmac.new(key, SIGNING_DOMAIN + canonical_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--v1-planner-module", required=True, type=Path)
    parser.add_argument("--handoff-checker", required=True, type=Path)
    parser.add_argument("--activation-plan", required=True, type=Path)
    parser.add_argument("--pending", required=True, type=Path)
    parser.add_argument("--handoff", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        v1 = load_v1(args.v1_planner_module)
        key = v1.read_key(args.key_file)
        handoff = verify_handoff(args)
        rendered_raw, rendered = v1.render_compose(args.compose_file, args.env_file)
        v1.validate_rendered_compose(rendered)
        v1.safe_output_root(args.output_root)
        activation_id = handoff.get("activationId")
        if not isinstance(activation_id, str) or not ACTIVATION_ID.fullmatch(activation_id):
            fail("ACTIVATION_ID_INVALID", "target handoff activation ID is invalid")
        for field in ("planFingerprint", "handoffFingerprint", "handoffFileSha256", "targetConfigAttestationSha256", "targetEnvFingerprint"):
            if not isinstance(handoff.get(field), str) or not SHA256.fullmatch(handoff[field]):
                fail("SERVICE_CUTOVER_HANDOFF_BINDING_INVALID", f"invalid {field}")
        binding = {
            "activationId": activation_id,
            "executionId": handoff["executionId"],
            "activationPlanPath": str(args.activation_plan),
            "activationPlanFileSha256": v1.sha256_bytes(v1.read_file(args.activation_plan, "ACTIVATION_PLAN", private=True)),
            "pendingEvidencePath": str(args.pending),
            "pendingEvidenceFileSha256": v1.sha256_bytes(v1.read_file(args.pending, "ACTIVATION_PENDING", private=True)),
            "targetHandoffPath": str(args.handoff),
            "targetHandoffFingerprint": handoff["handoffFingerprint"],
            "targetHandoffFileSha256": handoff["handoffFileSha256"],
            "targetConfigAttestationSha256": handoff["targetConfigAttestationSha256"],
            "activationPlanFingerprint": handoff["planFingerprint"],
            "envFilePath": str(args.env_file),
            "targetEnvFingerprint": handoff["targetEnvFingerprint"],
            "composeFilePath": str(args.compose_file),
            "composeFileSha256": v1.sha256_bytes(v1.read_file(args.compose_file, "SERVICE_CUTOVER_COMPOSE")),
            "renderedComposeSha256": v1.sha256_bytes(rendered_raw),
        }
        cutover_id = "cutover-" + hashlib.sha256(canonical_json(binding).encode()).hexdigest()[:32]
        record: dict[str, Any] = {
            "serviceCutoverPlanVersion": PLAN_VERSION,
            "cutoverId": cutover_id,
            **binding,
            "preflightService": v1.PREFLIGHT_SERVICE,
            "recreateServices": list(v1.RECREATE_SERVICES),
            "preserveServices": list(v1.PRESERVE_SERVICES),
            "requiredPrivacyEnvironment": v1.TARGET,
            "targetHandoffRequiredBeforePlanning": True,
            "targetHandoffIsNonterminal": True,
            "preflightMustSucceedBeforeMutation": True,
            "renderedComposeMustRemainBound": True,
            "caddyContainerMustBePreserved": True,
            "libsqlContainerMustBePreserved": True,
            "liveBaselineRequiredBeforeMutation": True,
            "appHealthcheckRequired": True,
            "backgroundServicesRunningRequired": True,
            "liveRuntimeEnvironmentAttestationRequired": True,
            "liveRuntimeCompletionRequiredAfterCutover": True,
            "rollbackOnCutoverFailureRequired": True,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }
        record["cutoverPlanFingerprint"] = v1.sha256_bytes(canonical_json(record).encode())
        envelope = {"envelopeVersion": 1, "record": record, "signature": sign(record, key)}
        path = args.output_root / f"{cutover_id}.v2.json"
        created = v1.persist(path, envelope)
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN_V2",
            "status": "SERVICE_CUTOVER_PLAN_READY",
            "cutoverId": cutover_id,
            "activationId": activation_id,
            "cutoverPlanFingerprint": record["cutoverPlanFingerprint"],
            "planPath": str(path),
            "planCreated": created,
            "planReused": not created,
            "serviceCutoverExecutionAllowed": True,
            "liveBaselineRequiredBeforeMutation": True,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":")))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "mode": "BACKUP_PRIVACY_SERVICE_CUTOVER_PLAN_V2",
            "status": "BLOCKED",
            "blocker": str(exc).split(":", 1)[0],
            "serviceCutoverExecutionAllowed": False,
            "serviceCutoverExecuted": False,
            "liveRuntimeAttested": False,
            "activationExecuted": False,
        }, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
