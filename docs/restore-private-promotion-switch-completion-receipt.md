# Restore Promotion Switch Completion Receipt v1

## Purpose

The signed completion receipt fulfills the switch-intent policy:

```text
SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK
```

It is created only after candidate selection is fully established and a technical post-switch healthcheck proves the promoted candidate set is healthy.

This slice remains evidence-only with respect to production state: it does not stop/start services, change Docker selectors, perform rollback, or change `PRIVACY_BACKUP_STATE`. It does, however, make the receipt a mandatory cryptographic prerequisite for the operational `COMPLETED` event.

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

If rollback has started, receipt creation is forbidden.

## Canonical persistence location

The receipt is persisted in the same durable switch execution-evidence directory as the journal-derived execution events:

```text
promotion-switch-completion-receipt.json
```

There is deliberately no independent completion-receipt directory. Event completion and read-only terminal assessment both resolve the receipt from the execution directory, so a valid receipt cannot be written to an unrelated path and accidentally escape the completion gate.

The directory is `0700`; the receipt is exclusive-create `0600`. An identical retry reuses the existing signed receipt and its original completion timestamp.

## Receipt contents

The receipt binds:

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

The evidence-only creation command is:

```bash
pnpm --filter @masters/db backup:restore-promotion-switch-completion-receipt
```

It authenticates switch intent, verifies journal and execution events, validates the post-switch healthcheck, and persists/reuses the signed receipt in `RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_DIR`.

## Mandatory COMPLETED gate

`backup:restore-promotion-switch-event` now treats `COMPLETED` specially:

1. authenticate intent,
2. verify durable journal,
3. verify the current execution-event chain,
4. resolve `promotion-switch-completion-receipt.json` from the same execution directory,
5. verify its HMAC and exact journal / `CANDIDATE_SELECTED` binding,
6. only then persist the terminal `COMPLETED` event.

No receipt, a tampered receipt, or a receipt bound to different evidence causes completion to fail closed.

The receipt can be created only while `CANDIDATE_SELECTED` is the latest execution evidence. After a legal `COMPLETED` event it remains verifiable for audit/recovery, but it cannot first be created after completion.

## Terminal read-only assessment

`backup:restore-promotion-switch-assess` also requires the same signed receipt whenever the execution state machine reports `COMPLETED`. Therefore a terminal candidate-mounted state is not accepted merely because a `COMPLETED` event file exists; the health-bound completion evidence must still verify cryptographically.

## Scope boundary

Still out of scope in this slice:

- Docker service stop/start,
- selector activation,
- rollback activation,
- collection of the post-switch healthcheck from live Docker state,
- rollback-volume cleanup,
- transition of `PRIVACY_BACKUP_STATE`.

The next safe slice can implement the bounded Docker cutover executor. It must produce the post-switch healthcheck, persist this receipt, then request `COMPLETED`; it may not bypass the receipt gate.
