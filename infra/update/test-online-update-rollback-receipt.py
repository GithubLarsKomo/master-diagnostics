#!/usr/bin/env python3
from __future__ import annotations

import base64
import importlib.util
import json
import tempfile
from pathlib import Path


def load_receipt_module():
    path = Path(__file__).with_name("persist-online-update-rollback-receipt.py")
    spec = importlib.util.spec_from_file_location("master_diagnostics_online_update_rollback_receipt", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hmac_value(char: str) -> str:
    return "hmac-sha256:" + char * 64


def sha_value(char: str) -> str:
    return "sha256:" + char * 64


def journal_fixture() -> dict:
    return {
        "envelopeVersion": 1,
        "record": {
            "targetVersion": "1.2.3",
            "rollbackAnchor": {
                "fileName": "masters-backup-20260810T120000Z-11111111-1111-4111-8111-111111111111.mdbak",
                "sha256": sha_value("a"),
                "createdAt": "2026-08-10T12:00:00.000Z",
                "verified": True,
                "rollbackAnchor": True,
            },
        },
        "signature": hmac_value("1"),
    }


def rollback_started_fixture() -> dict:
    return {
        "envelopeVersion": 1,
        "record": {
            "phase": "ROLLBACK_STARTED",
            "recordedAt": "2026-08-10T13:00:00.000Z",
            "rollbackStarted": True,
            "terminal": False,
            "updateExecuted": False,
        },
        "signature": hmac_value("2"),
    }


def restore_fixture() -> dict:
    return {
        "mode": "RESTORE_PROMOTION_SWITCH_COMPLETION_RECEIPT_VERIFICATION",
        "status": "VERIFIED",
        "receiptVersion": 1,
        "receiptSignature": hmac_value("3"),
        "completedAt": "2026-08-10T13:30:00.000Z",
        "journalFingerprint": sha_value("b"),
        "journalSignature": hmac_value("4"),
        "candidateSetId": "restore-0123456789abcdefabcd",
        "candidateSetFingerprint": sha_value("c"),
        "candidateSelectedEventSignature": hmac_value("5"),
        "sourceProvenanceBindingSignature": hmac_value("6"),
        "sourceProvenanceBindingFingerprint": sha_value("d"),
        "sourceProvenanceSignature": hmac_value("7"),
        "sourceStagingName": "restore-20260810T120000Z-11111111-1111-4111-8111-111111111111",
        "sourceBackupFileName": journal_fixture()["record"]["rollbackAnchor"]["fileName"],
        "sourceBackupSha256": journal_fixture()["record"]["rollbackAnchor"]["sha256"],
        "sourceBackupCreatedAt": journal_fixture()["record"]["rollbackAnchor"]["createdAt"],
        "sourceBackupManifestFingerprint": sha_value("e"),
        "postSwitchHealthcheckFingerprint": sha_value("f"),
        "currentVolumeSet": [],
        "libsqlHealth": "healthy",
        "appHealth": "healthy",
        "exportCleanupRunning": True,
        "retentionScanRunning": True,
        "caddyPreserved": True,
        "rollbackVolumesRetained": True,
        "productionMutationCompleted": True,
        "promotionExecuted": True,
    }


def expect_error(fn, contains: str) -> None:
    try:
        fn()
    except Exception as exc:
        assert contains in str(exc), (contains, str(exc))
        return
    raise AssertionError(f"Expected error containing {contains!r}")


def main() -> int:
    module = load_receipt_module()
    journal = journal_fixture()
    rollback_started = rollback_started_fixture()
    restore = module.validate_restore_verification(restore_fixture())

    record = module.create_record(
        journal,
        rollback_started,
        restore,
        "2026-08-10T14:00:00.000Z",
    )
    assert record["phase"] == "VERIFIED_RESTORE_ROLLBACK"
    assert record["rollbackBackupFileName"] == journal["record"]["rollbackAnchor"]["fileName"]
    assert record["rollbackBackupSha256"] == journal["record"]["rollbackAnchor"]["sha256"]
    assert record["rollbackBackupCreatedAt"] == journal["record"]["rollbackAnchor"]["createdAt"]
    assert record["rollbackStartedEventSignature"] == rollback_started["signature"]
    assert record["restoreCompletionReceiptSignature"] == restore["receiptSignature"]
    assert record["rollbackReceiptRequiredBeforeRollbackCompleted"] is True
    assert record["rollbackCompleted"] is False
    assert record["updateExecuted"] is False
    assert record["receiptFingerprint"].startswith("sha256:")

    for field, replacement in (
        ("sourceBackupFileName", "other.mdbak"),
        ("sourceBackupSha256", sha_value("9")),
        ("sourceBackupCreatedAt", "2026-08-10T11:59:59.000Z"),
    ):
        changed = dict(restore)
        changed[field] = replacement
        expect_error(
            lambda changed=changed: module.create_record(
                journal, rollback_started, changed, "2026-08-10T14:00:00.000Z"
            ),
            "does not match the journal-bound pre-update rollback backup",
        )

    earlier = dict(restore)
    earlier["completedAt"] = "2026-08-10T14:30:00.000Z"
    expect_error(
        lambda: module.create_record(journal, rollback_started, earlier, "2026-08-10T14:00:00.000Z"),
        "cannot precede restore completion",
    )

    wrong_phase = json.loads(json.dumps(rollback_started))
    wrong_phase["record"]["phase"] = "WRITERS_STOPPED"
    expect_error(
        lambda: module.create_record(journal, wrong_phase, restore, "2026-08-10T14:00:00.000Z"),
        "requires ROLLBACK_STARTED",
    )

    with tempfile.TemporaryDirectory(prefix="online-update-rollback-receipt-") as tmp:
        root = Path(tmp)
        target = root / "receipt"
        key_file = root / "receipt.key"
        key_file.write_text(base64.b64encode(bytes([71]) * 32).decode() + "\n", encoding="utf-8")
        key_file.chmod(0o600)
        key = module.read_key(key_file)
        path, created, envelope = module.persist(target, key, record)
        assert created is True
        assert path.name == module.FILE_NAME
        assert target.stat().st_mode & 0o777 == 0o700
        assert path.stat().st_mode & 0o777 == 0o600
        verified = module.verify_envelope(json.loads(path.read_text(encoding="utf-8")), key)
        assert verified == envelope

        path2, created2, envelope2 = module.persist(target, key, record)
        assert path2 == path
        assert created2 is False
        assert envelope2 == envelope

        tampered = json.loads(path.read_text(encoding="utf-8"))
        tampered["record"]["restoreSourceStagingName"] = "restore-tampered"
        expect_error(lambda: module.verify_envelope(tampered, key), "fingerprint does not match")

        tampered_signature = json.loads(path.read_text(encoding="utf-8"))
        tampered_signature["signature"] = hmac_value("8")
        expect_error(lambda: module.verify_envelope(tampered_signature, key), "signature verification failed")

        conflicting = dict(record)
        conflicting["recordedAt"] = "2026-08-10T14:00:01.000Z"
        conflicting["receiptFingerprint"] = module.fingerprint_record(conflicting)
        expect_error(
            lambda: module.persist(target, key, conflicting),
            "does not match the requested verified rollback",
        )

    print(json.dumps({
        "status": "OK",
        "receiptFingerprint": record["receiptFingerprint"],
        "rollbackBackupSha256": record["rollbackBackupSha256"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
