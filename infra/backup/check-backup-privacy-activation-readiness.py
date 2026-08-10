#!/usr/bin/env python3
"""Read-only gate for considering backup privacy capability activation after a real RTO drill."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
from typing import Any


def fail(code: str, message: str) -> "NoReturn":
    raise ValueError(f"{code}: {message}")


def load_report_verifier(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail("DRILL_REPORT_VERIFIER_UNSAFE", "canonical drill report verifier must be an absolute regular non-symlink file")
    spec = importlib.util.spec_from_file_location("restore_rto_drill_report_verifier", path)
    if spec is None or spec.loader is None:
        fail("DRILL_REPORT_VERIFIER_INVALID", "could not load canonical drill report verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "verify_report", None)):
        fail("DRILL_REPORT_VERIFIER_INVALID", "canonical drill report verifier does not expose verify_report")
    return module


def activation_blockers(verified: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if verified.get("drillStatus") != "COMPLETED":
        blockers.append("DRILL_NOT_COMPLETED")
    if verified.get("rtoMet") is not True:
        blockers.append("RTO_TARGET_NOT_MET")
    if verified.get("privacyReconciliationIncluded") is not True:
        blockers.append("PRIVACY_RECONCILIATION_NOT_PROVEN")
    if verified.get("controlledPromotionIncluded") is not True:
        blockers.append("CONTROLLED_PROMOTION_NOT_PROVEN")
    if verified.get("practicalRestoreEvidenceVerified") is not True:
        blockers.append("PRACTICAL_RESTORE_EVIDENCE_NOT_VERIFIED")
    return blockers


def main() -> int:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--expected-bundle-name", required=True)
    parser.add_argument("--expected-bundle-sha256", required=True)
    parser.add_argument(
        "--report-verifier",
        type=Path,
        default=root / "check-restore-rto-drill-report.py",
    )
    args = parser.parse_args()

    current_state = os.environ.get("PRIVACY_BACKUP_STATE", "").strip()
    blockers: list[str] = []
    if current_state != "DISABLED":
        blockers.append("BACKUP_CAPABILITY_NOT_DISABLED_DURING_READINESS_REVIEW")

    verified: dict[str, Any] | None = None
    try:
        verifier = load_report_verifier(args.report_verifier)
        verified = verifier.verify_report(
            args.report,
            args.key_file,
            args.expected_bundle_name,
            args.expected_bundle_sha256,
        )
        blockers.extend(activation_blockers(verified))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        message = str(exc)
        code = message.split(":", 1)[0] if ":" in message else "DRILL_REPORT_VERIFICATION_FAILED"
        blockers.append(code)

    blockers = sorted(set(blockers))
    ready = not blockers
    output = {
        "mode": "BACKUP_PRIVACY_ACTIVATION_READINESS",
        "status": "READY_FOR_MANUAL_ATTESTATION" if ready else "BLOCKED",
        "readinessVersion": 1,
        "currentPrivacyBackupState": current_state or None,
        "canonicalDrillReportVerification": True if verified is not None else False,
        "bundleBytesBound": bool(verified is not None and verified.get("bundleName") == args.expected_bundle_name and verified.get("bundleFingerprint") == args.expected_bundle_sha256),
        "drillReportVerified": verified is not None,
        "drillId": verified.get("drillId") if verified else None,
        "reportFingerprint": verified.get("reportFingerprint") if verified else None,
        "bundleName": verified.get("bundleName") if verified else None,
        "bundleFingerprint": verified.get("bundleFingerprint") if verified else None,
        "rtoMet": verified.get("rtoMet") if verified else False,
        "privacyReconciliationProven": verified.get("privacyReconciliationIncluded") if verified else False,
        "controlledPromotionProven": verified.get("controlledPromotionIncluded") if verified else False,
        "practicalRestoreEvidenceVerified": verified.get("practicalRestoreEvidenceVerified") if verified else False,
        "blockers": blockers,
        "automaticActivationPerformed": False,
        "privacyBackupActivationAllowed": False,
        "manualAttestationTarget": {
            "PRIVACY_BACKUP_STATE": "ENABLED",
            "PRIVACY_BACKUP_POLICY_VERSION": "1.0.0",
            "PRIVACY_BACKUP_ENCRYPTED_AT_REST": "true",
            "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED": "true",
            "PRIVACY_BACKUP_RESTORE_RECONCILIATION": "true",
        } if ready else None,
    }
    print(json.dumps(output, separators=(",", ":"), ensure_ascii=False))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
