#!/usr/bin/env python3
"""Fail-closed verifier for practical beta restore-drill operator evidence."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path
from typing import Any

COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
EXPECTED_FIELDS = {
    "evidenceVersion",
    "hostId",
    "deploymentCommitSha",
    "bundleName",
    "bundleFingerprint",
    "rtoReportPath",
    "healthcheckPassed",
    "trainerReadPathPassed",
    "sampleDataPassed",
    "caddyPreserved",
    "unexpectedVolumeLoss",
    "deviations",
}


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def load_rto_checker(script_path: Path):
    spec = importlib.util.spec_from_file_location("restore_rto_checker", script_path)
    if spec is None or spec.loader is None:
        fail("BETA_RESTORE_CHECKER_IMPORT_FAILED", "cannot load restore RTO checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("BETA_RESTORE_EVIDENCE_UNSAFE", "evidence must be an absolute regular non-symlink file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("BETA_RESTORE_EVIDENCE_INVALID: evidence is not JSON") from exc
    if not isinstance(value, dict) or set(value) != EXPECTED_FIELDS:
        fail("BETA_RESTORE_EVIDENCE_SHAPE_INVALID", "evidence fields differ from contract v1")
    return value


def verify(evidence: dict[str, Any], key_file: Path, checker_path: Path) -> dict[str, Any]:
    if evidence["evidenceVersion"] != 1:
        fail("BETA_RESTORE_EVIDENCE_VERSION_INVALID", "evidenceVersion must be 1")
    host_id = evidence["hostId"]
    if not isinstance(host_id, str) or not host_id.strip() or len(host_id) > 200:
        fail("BETA_RESTORE_HOST_INVALID", "hostId must be a non-empty stable identifier")
    commit_sha = evidence["deploymentCommitSha"]
    if not isinstance(commit_sha, str) or not COMMIT_SHA.fullmatch(commit_sha):
        fail("BETA_RESTORE_COMMIT_INVALID", "deploymentCommitSha must be a full lowercase Git SHA")
    bundle_name = evidence["bundleName"]
    bundle_fingerprint = evidence["bundleFingerprint"]
    if not isinstance(bundle_name, str) or not bundle_name.startswith("masters-backup-") or not bundle_name.endswith(".mdbak"):
        fail("BETA_RESTORE_BUNDLE_INVALID", "bundleName is invalid")
    if not isinstance(bundle_fingerprint, str) or not SHA256.fullmatch(bundle_fingerprint):
        fail("BETA_RESTORE_BUNDLE_INVALID", "bundleFingerprint must be sha256:<64 hex>")
    report_path_raw = evidence["rtoReportPath"]
    if not isinstance(report_path_raw, str):
        fail("BETA_RESTORE_REPORT_INVALID", "rtoReportPath must be a string")
    report_path = Path(report_path_raw)
    if not report_path.is_absolute():
        fail("BETA_RESTORE_REPORT_INVALID", "rtoReportPath must be absolute")

    required_true = (
        "healthcheckPassed",
        "trainerReadPathPassed",
        "sampleDataPassed",
        "caddyPreserved",
    )
    for field in required_true:
        if evidence[field] is not True:
            fail("BETA_RESTORE_OPERATIONAL_CHECK_FAILED", f"{field} must be true")
    if evidence["unexpectedVolumeLoss"] is not False:
        fail("BETA_RESTORE_VOLUME_LOSS_DETECTED", "unexpectedVolumeLoss must be false")
    deviations = evidence["deviations"]
    if not isinstance(deviations, list) or any(not isinstance(item, str) or not item.strip() for item in deviations):
        fail("BETA_RESTORE_DEVIATIONS_INVALID", "deviations must be an array of non-empty strings")
    if deviations:
        fail("BETA_RESTORE_DEVIATIONS_OPEN", "beta gate requires no unresolved deviations")

    checker = load_rto_checker(checker_path)
    verified = checker.verify_report(
        report_path,
        key_file,
        expected_bundle_name=bundle_name,
        expected_bundle_sha256=bundle_fingerprint,
    )
    if verified.get("practicalRestoreEvidenceVerified") is not True:
        fail("BETA_RESTORE_RTO_REPORT_NOT_READY", "signed RTO report does not prove completed restore within RTO")

    return {
        "betaRestoreGateReady": True,
        "hostId": host_id,
        "deploymentCommitSha": commit_sha,
        "bundleName": bundle_name,
        "bundleFingerprint": bundle_fingerprint,
        "drillId": verified["drillId"],
        "reportFingerprint": verified["reportFingerprint"],
        "durationSeconds": verified["durationSeconds"],
        "rtoMet": verified["rtoMet"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--rto-key-file", required=True, type=Path)
    parser.add_argument(
        "--rto-checker",
        type=Path,
        default=Path(__file__).with_name("check-restore-rto-drill-report.py"),
    )
    args = parser.parse_args()
    try:
        result = verify(read_json(args.evidence), args.rto_key_file, args.rto_checker)
    except ValueError as exc:
        print(str(exc))
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
