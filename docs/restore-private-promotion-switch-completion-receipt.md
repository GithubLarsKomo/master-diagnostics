# Restore Promotion Switch Completion Receipt v1

## Purpose

The signed completion receipt fulfills the switch-intent policy:

```text
SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK
```

It is created only after candidate selection is fully established and a technical post-switch healthcheck proves the promoted candidate set is healthy.

This slice is evidence-only. It does not stop/start services, change Docker selectors, perform rollback, or change `PRIVACY_BACKUP_STATE`.

## Required evidence

Receipt creation requires:

1. verified durable #214 switch journal,
2. verified #215/#217 execution-event chain whose latest event is `CANDIDATE_SELECTED`,
3. a post-switch healthcheck with:
   - exact candidate-set ID,
   - exact four journal-bound candidate volume names,
   - `currentVolumeSet=CANDIDATE`,
   - libSQL healthy,
   - app healthy,
   - export-cleanup running,
   - retention-scan running,
   - Caddy preserved,
   - rollback volumes retained.

If rollback has started, the latest event is no longer `CANDIDATE_SELECTED` and receipt creation is forbidden.

## Receipt contents

`promotion-switch-completion-receipt.json` binds:

- receipt version/status,
- completion timestamp,
- journal fingerprint and signature,
- candidate-set ID and fingerprint,
- signed `CANDIDATE_SELECTED` event signature,
- post-switch healthcheck fingerprint,
- candidate health state,
- exact four candidate volume names,
- Caddy-preserved assertion,
- rollback-volume-retained assertion,
- `productionMutationCompleted=true`,
- `promotionExecuted=true`.

The HMAC signing domain is:

```text
masters:restore-private-promotion-switch-completion-receipt:v1
```

The receipt target directory is `0700`; the file is exclusive-create `0600`. An identical retry reuses the existing signed receipt and its original completion timestamp.

## Post-switch healthcheck shape

The normalized technical report uses:

```text
mode=CLUB_RESTORE_PROMOTION_POST_SWITCH_HEALTHCHECK
status=HEALTHY
healthcheckVersion=1
currentVolumeSet=CANDIDATE
libsqlHealth=HEALTHY
appHealth=HEALTHY
exportCleanupRunning=true
retentionScanRunning=true
caddyPreserved=true
rollbackVolumesRetained=true
```

and exactly four ordered candidate volume identities.

The receipt stores a SHA-256 fingerprint of the normalized healthcheck body rather than arbitrary logs or response payloads.

## CLI

The evidence-only CLI implementation is:

```text
packages/db/src/prepare-restore-private-promotion-switch-completion-receipt.ts
```

It authenticates switch intent, verifies journal and execution events, validates the post-switch healthcheck, and persists/reuses the signed receipt.

This slice intentionally does not yet wire the CLI into the operational `COMPLETED` event path. The next executor slice must create and verify this receipt **before** it is allowed to persist `COMPLETED`.

## Scope boundary

Still out of scope in this slice:

- Docker service stop/start,
- selector activation,
- rollback activation,
- healthcheck collection from Docker,
- operational `COMPLETED` gate,
- rollback cleanup,
- transition of `PRIVACY_BACKUP_STATE`.
