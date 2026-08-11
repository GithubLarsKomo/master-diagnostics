# Online Update Execution Events v1

## Purpose

The online-update execution-event protocol is the append-only crash/retry evidence layer between the durable pre-mutation execution journal and bounded mutating executors.

It does not itself pull images, stop services, run migrations, start services, contact a registry, restore a backup, or mark runtime health by observation. It only records HMAC-signed execution boundaries.

## Why started-events are required

A success-only event stream cannot distinguish a crash before a side effect from a crash after that side effect began. Therefore every later side-effect family has a durable pre-action boundary.

The normal successful chain is:

1. `IMAGE_ACQUISITION_STARTED`
2. `IMAGES_ACQUIRED`
3. `WRITER_STOP_STARTED`
4. `WRITERS_STOPPED`
5. `MIGRATION_STARTED`
6. `MIGRATION_COMPLETED`
7. `APPLICATION_START_STARTED`
8. `APPLICATION_STARTED`
9. `HEALTH_VERIFIED`
10. `COMPLETED`

`COMPLETED` is terminal and is the only phase with `updateExecuted=true`.

## Abort before production mutation

Before `WRITER_STOP_STARTED`, a failed execution does not require restoration of the verified pre-update backup because production has not been mutated.

From `IMAGE_ACQUISITION_STARTED` or `IMAGES_ACQUIRED`, the executor may terminate with:

```text
ABORTED_BEFORE_PRODUCTION_MUTATION
```

This terminal state must retain `productionMutationStarted=false` and `updateExecuted=false`.

## Rollback after production mutation begins

From `WRITER_STOP_STARTED` onward, any non-success outcome must enter the explicit rollback chain:

```text
ROLLBACK_STARTED -> verified rollback receipt -> ROLLBACK_COMPLETED
```

`ROLLBACK_STARTED` is persisted before the restore of the journal-bound verified pre-update backup. This makes a crash during rollback distinguishable from a rollback that never began.

Rollback may begin after:

- writer stop starts or completes,
- migration starts or completes,
- application start begins or completes,
- target health is verified but completion has not yet been recorded.

`ROLLBACK_COMPLETED` is terminal with `updateExecuted=false`, but it is no longer authorized by transition order alone.

## Mandatory rollback receipt gate

Before `ROLLBACK_COMPLETED` can be persisted, the canonical event writer must verify the HMAC-signed `online-update-rollback-receipt.json` introduced by the rollback-receipt contract.

The receipt must prove all of the following against the current verified event/journal state:

- its `onlineUpdateJournalSignature` equals the supplied execution-journal signature,
- its `rollbackStartedEventSignature` equals the exact current `ROLLBACK_STARTED` event signature,
- its target version equals the journal target version,
- rollback backup file name, SHA-256 and `createdAt` exactly equal the journal `rollbackAnchor`,
- its timestamp does not precede `ROLLBACK_STARTED`,
- its verified restore completion does not occur after the receipt timestamp,
- `rollbackReceiptRequiredBeforeRollbackCompleted=true`,
- `rollbackCompleted=false`,
- `updateExecuted=false`,
- the receipt content fingerprint and HMAC are valid.

The receipt itself already proves that the exact journal-bound pre-update `.mdbak` bundle was the source of an independently verified completed restore-promotion chain. Therefore a successful restore of a different authentic backup cannot authorize terminal rollback evidence.

The gate is enforced inside `persist-online-update-execution-event.py`. A caller cannot bypass it by using the generic event CLI directly.

## Terminal rollback CLI

All non-rollback-terminal phases retain the existing CLI surface. `ROLLBACK_COMPLETED` additionally requires:

```bash
python3 infra/update/persist-online-update-execution-event.py \
  --journal /absolute/path/online-update-execution-journal.json \
  --journal-key /absolute/path/online-update-execution-journal.key \
  --target-dir /var/lib/master-diagnostics/online-update/<execution-id>/events \
  --key-file /etc/master-diagnostics/online-update-execution-event.key \
  --phase ROLLBACK_COMPLETED \
  --recorded-at 2026-08-10T09:30:00.000Z \
  --rollback-receipt /absolute/path/online-update-rollback-receipt.json \
  --rollback-receipt-key /etc/master-diagnostics/online-update-rollback-receipt.key
```

The two receipt arguments are rejected for every other phase so callers cannot accidentally imply rollback evidence where none is relevant.

## Crash/retry behavior

The receipt gate is also applied on an idempotent retry after `ROLLBACK_COMPLETED` already exists. In that case the writer resolves the immediately preceding verified `ROLLBACK_STARTED` event and re-verifies the same receipt before reusing the terminal event.

Consequently, deletion, substitution or tampering of the rollback receipt causes a later terminal retry/verification attempt to fail closed instead of silently accepting historical terminal state.

## Event identity and chain

Each event binds:

- event version and contiguous sequence number,
- canonical UTC timestamp,
- execution-journal HMAC signature,
- execution-plan HMAC signature,
- exact execution-plan envelope SHA-256 inherited from the journal,
- target version,
- previous event HMAC signature,
- cumulative execution state,
- target outcome and terminal state.

The HMAC domain is:

```text
masters:club-online-update-execution-event:v1
```

The event directory is mode `0700`; individual event files are mode `0600` and are exclusive-create.

File names are phase-derived, for example:

```text
online-update-event-image-acquisition-started.json
online-update-event-writer-stop-started.json
online-update-event-rollback-started.json
online-update-event-rollback-completed.json
```

## Cumulative state

Events carry cumulative booleans for:

- image acquisition started,
- images acquired,
- production mutation started,
- writers stopped,
- migration started/completed,
- application start started/completed,
- health verified,
- rollback started.

The reader recomputes the expected cumulative state from the verified prior event and rejects any mismatch. It also rejects sequence gaps, duplicate phases, signature-chain breaks, timestamp reversal, unknown transitions, journal identity drift, and HMAC tampering.

## General retry behavior

If the requested phase is already the latest valid event, the writer reuses it without changing its original timestamp or signature. If the same phase has already been superseded by later evidence, the request fails closed instead of pretending the caller is current.

For `ROLLBACK_COMPLETED`, receipt verification occurs before this reuse decision as described above.

## General CLI

```bash
python3 infra/update/persist-online-update-execution-event.py \
  --journal /absolute/path/online-update-execution-journal.json \
  --journal-key /absolute/path/online-update-execution-journal.key \
  --target-dir /var/lib/master-diagnostics/online-update/<execution-id>/events \
  --key-file /etc/master-diagnostics/online-update-execution-event.key \
  --phase IMAGE_ACQUISITION_STARTED \
  --recorded-at 2026-08-10T09:00:01.000Z
```

Output mode remains:

```text
CLUB_ONLINE_UPDATE_EXECUTION_EVENT_V1
```

The response reports sequence, phase, signature, previous signature, legal next phases, and cumulative production/migration state.

## Safety boundary

This protocol creates evidence only. It contains no Docker/Compose invocation, registry access, HTTP client, migration runner, backup restore, or service control.

The rollback-receipt module is loaded only as an evidence verifier. Restore cryptography remains delegated to the separately created receipt; the event writer performs no restore operation and has no subprocess path.

With this gate, terminal rollback evidence can no longer be produced merely because `ROLLBACK_STARTED` exists. A later rollback executor may only claim completion after it has produced the independently verifiable receipt for the exact pre-update backup.