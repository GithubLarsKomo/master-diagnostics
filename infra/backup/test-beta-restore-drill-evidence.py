#!/usr/bin/env python3
"""Contract tests for the fail-closed beta restore evidence verifier."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

CHECKER_PATH = Path(__file__).with_name("check-beta-restore-drill-evidence.py")


def load_checker():
    spec = importlib.util.spec_from_file_location("beta_restore_evidence_checker", CHECKER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot import beta restore evidence checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


checker = load_checker()


class BetaRestoreEvidenceContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name).resolve()
        self.report = self.root / "restore-rto-report.json"
        self.report.write_text("{}\n", encoding="utf-8")
        self.key = self.root / "restore-rto.key"
        self.key.write_text("test-key\n", encoding="utf-8")
        self.evidence = {
            "evidenceVersion": 1,
            "hostId": "club-host-01",
            "deploymentCommitSha": "a" * 40,
            "bundleName": "masters-backup-20260811T120000Z.mdbak",
            "bundleFingerprint": "sha256:" + "b" * 64,
            "rtoReportPath": str(self.report),
            "healthcheckPassed": True,
            "trainerReadPathPassed": True,
            "sampleDataPassed": True,
            "caddyPreserved": True,
            "unexpectedVolumeLoss": False,
            "deviations": [],
        }

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_rto_checker(self, *, ready: bool = True) -> Path:
        path = self.root / ("ready-rto-checker.py" if ready else "not-ready-rto-checker.py")
        payload = {
            "practicalRestoreEvidenceVerified": ready,
            "drillId": "restore-20260811T120000Z",
            "reportFingerprint": "sha256:" + "c" * 64,
            "durationSeconds": 321,
            "rtoMet": ready,
        }
        path.write_text(
            "def verify_report(report_path, key_file, **kwargs):\n"
            f"    return {payload!r}\n",
            encoding="utf-8",
        )
        return path

    def assert_fails(self, expected_code: str, evidence: dict, *, ready: bool = True) -> None:
        with self.assertRaisesRegex(ValueError, rf"^{expected_code}:"):
            checker.verify(evidence, self.key, self.write_rto_checker(ready=ready))

    def test_accepts_complete_bound_operator_evidence(self) -> None:
        result = checker.verify(self.evidence, self.key, self.write_rto_checker())
        self.assertEqual(
            result,
            {
                "betaRestoreGateReady": True,
                "hostId": "club-host-01",
                "deploymentCommitSha": "a" * 40,
                "bundleName": "masters-backup-20260811T120000Z.mdbak",
                "bundleFingerprint": "sha256:" + "b" * 64,
                "drillId": "restore-20260811T120000Z",
                "reportFingerprint": "sha256:" + "c" * 64,
                "durationSeconds": 321,
                "rtoMet": True,
            },
        )

    def test_rejects_failed_operational_check(self) -> None:
        evidence = dict(self.evidence, trainerReadPathPassed=False)
        self.assert_fails("BETA_RESTORE_OPERATIONAL_CHECK_FAILED", evidence)

    def test_rejects_unexpected_volume_loss(self) -> None:
        evidence = dict(self.evidence, unexpectedVolumeLoss=True)
        self.assert_fails("BETA_RESTORE_VOLUME_LOSS_DETECTED", evidence)

    def test_rejects_open_deviation(self) -> None:
        evidence = dict(self.evidence, deviations=["Caddy state was not verified"])
        self.assert_fails("BETA_RESTORE_DEVIATIONS_OPEN", evidence)

    def test_rejects_rto_report_that_is_not_practical_evidence(self) -> None:
        self.assert_fails("BETA_RESTORE_RTO_REPORT_NOT_READY", self.evidence, ready=False)

    def test_rejects_noncanonical_commit_sha(self) -> None:
        evidence = dict(self.evidence, deploymentCommitSha="A" * 40)
        self.assert_fails("BETA_RESTORE_COMMIT_INVALID", evidence)

    def test_read_json_rejects_contract_shape_drift(self) -> None:
        evidence_path = self.root / "evidence.json"
        payload = dict(self.evidence, unexpectedField=True)
        evidence_path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, r"^BETA_RESTORE_EVIDENCE_SHAPE_INVALID:"):
            checker.read_json(evidence_path)

    def test_read_json_rejects_symlink(self) -> None:
        target = self.root / "evidence-target.json"
        target.write_text(json.dumps(self.evidence), encoding="utf-8")
        symlink = self.root / "evidence-link.json"
        symlink.symlink_to(target)
        with self.assertRaisesRegex(ValueError, r"^BETA_RESTORE_EVIDENCE_UNSAFE:"):
            checker.read_json(symlink)


if __name__ == "__main__":
    unittest.main(verbosity=2)
