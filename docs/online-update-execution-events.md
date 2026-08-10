# Online Update Execution Events v1

## Purpose

The online-update execution-event protocol is the append-only crash/retry evidence layer between the durable pre-mutation execution journal and a later bounded mutating executor.

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
ROLLBACK_STARTED -> ROLLBACK_COMPLETED
```

`ROLLBACK_STARTED` is itself persisted before a future executor restores the journal-bound verified pre-update backup. This makes a crash during rollback distinguishable from a rollback that never began.

Rollback may begin after:

- writer stop starts or completes,
- migration starts or completes,
- application start begins or completes,
- target health is verified but completion has not yet been recorded.

`ROLLBACK_COMPLETED` is terminal with `updateExecuted=false`.

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

## Retry behavior

If the requested phase is already the latest valid event, the writer reuses it without changing its original timestamp or signature. If the same phase has already been superseded by later evidence, the request fails closed instead of pretending the caller is current.

## CLI

```bash
python3 infra/update/persist-online-update-execution-event.py \
  --journal /absolute/path/online-update-execution-journal.json \
  --journal-key /absolute/path/online-update-execution-journal.key \
  --target-dir /var/lib/master-diagnostics/online-update/<execution-id>/events \
  --key-file /etc/master-diagnostics/online-update-execution-event.key \
  --phase IMAGE_ACQUISITION_STARTED \
  --recorded-at 2026-08-10T09:00:01.000Z
```

Output mode:

```text
CLUB_ONLINE_UPDATE_EXECUTION_EVENT_V1
```

The response reports sequence, phase, signature, previous signature, legal next phases, and cumulative production/migration state.

## Safety boundary

This protocol creates evidence only. In particular it contains no Docker/Compose invocation, registry access, HTTP client, migration runner, backup restore, or service control.

The next safe slice can implement a bounded executor for the first external side effect, exact immutable image acquisition, provided it authenticates the plan and journal and persists `IMAGE_ACQUISITION_STARTED` first. Production service mutation remains separately gated by `WRITER_STOP_STARTED` and the verified pre-update backup rollback anchor.
