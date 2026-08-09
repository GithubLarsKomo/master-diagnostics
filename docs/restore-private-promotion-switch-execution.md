# Restore Promotion Switch Execution Evidence v1

## Purpose

The switch execution protocol is the crash/retry evidence layer between the durable PENDING switch journal and a future mutating Docker cutover.

It remains independent from Docker: the core service does not stop/start services, render selectors, or write product volumes. It records and assesses what a later executor is allowed to do.

`PRIVACY_BACKUP_STATE=DISABLED` remains unchanged.

## Signed execution events

Events use the promotion HMAC key with the dedicated domain:

```text
masters:restore-private-promotion-switch-execution-event:v1
```

Allowed transitions are:

```text
CUTOVER_STARTED
  -> CANDIDATE_SELECTED
       -> COMPLETED
       -> ROLLBACK_STARTED -> ROLLBACK_SELECTED -> ROLLBACK_VERIFIED
  -> ROLLBACK_STARTED -> ROLLBACK_SELECTED -> ROLLBACK_VERIFIED
```

`ROLLBACK_STARTED` is deliberately persisted **before** any rollback selector mutation. It removes the ambiguity between:

- a cutover that never started rollback, and
- a rollback that already changed Docker state but crashed before `ROLLBACK_SELECTED` evidence was written.

A rollback can therefore be triggered even when candidate activation failed before the complete candidate set became healthy.

Each event binds:

- contiguous sequence number,
- phase and canonical timestamp,
- journal fingerprint and signature,
- candidate-set ID,
- previous event signature,
- target volume set (`CANDIDATE` or `ROLLBACK`),
- `productionMutationStarted=true`,
- terminal flag,
- `promotionExecuted=true` only for `COMPLETED`.

Files are exclusive-create `0600`; the evidence directory is `0700`.

Fixed filenames:

```text
promotion-switch-cutover-started.json
promotion-switch-candidate-selected.json
promotion-switch-completed.json
promotion-switch-rollback-started.json
promotion-switch-rollback-selected.json
promotion-switch-rollback-verified.json
```

## Current-volume classification

The four actual Docker volume identities are classified against the journal-bound candidate and rollback sets as:

- `CANDIDATE`: all four exactly match candidate volumes,
- `ROLLBACK`: all four exactly match rollback volumes,
- `MIXED_KNOWN`: every role is one of its two authorized names, but the set is partially switched,
- `UNKNOWN`: at least one role uses a volume not authorized by the journal.

`UNKNOWN` is always blocked.

`MIXED_KNOWN` is accepted only when signed execution evidence already establishes the intended direction. This is required for crashes between individual service recreations; for example candidate libSQL may already be active while the stopped app container still references rollback report/export volumes.

## Deterministic recovery assessment

`assessRestorePrivatePromotionSwitchExecution(...)` combines the verified journal, signed event chain, and actual four-volume state.

| Last evidence | Current set | Assessment |
| --- | --- | --- |
| none | rollback | `READY_TO_START` |
| none | candidate/mixed/unknown | `BLOCKED` |
| `CUTOVER_STARTED` | rollback | `READY_TO_SELECT_CANDIDATE` |
| `CUTOVER_STARTED` | mixed known | `READY_TO_SELECT_CANDIDATE` |
| `CUTOVER_STARTED` | candidate | `RECOVER_CANDIDATE_SELECTION` |
| `CANDIDATE_SELECTED` | candidate | `VERIFY_CANDIDATE` |
| `CANDIDATE_SELECTED` | anything else | `BLOCKED` |
| `ROLLBACK_STARTED` | candidate | `READY_TO_SELECT_ROLLBACK` |
| `ROLLBACK_STARTED` | mixed known | `READY_TO_SELECT_ROLLBACK` |
| `ROLLBACK_STARTED` | rollback | `RECOVER_ROLLBACK_SELECTION` |
| `ROLLBACK_SELECTED` | rollback | `VERIFY_ROLLBACK` |
| `ROLLBACK_VERIFIED` | rollback | `ROLLED_BACK` |
| `COMPLETED` | candidate | `COMPLETED` |

The `RECOVER_*` states mean the real selector transition already completed but its corresponding evidence write did not. Recovery may persist the missing event only after current mount identity proves the transition.

The `READY_TO_SELECT_*` states permit a future executor to converge an authorized partial or unchanged set toward the direction already established by signed evidence.

Terminal evidence conflicting with live mounts is always blocked.

## Pre-cutover and post-cutover trust boundaries

Before `CUTOVER_STARTED`, the strict #212 candidate healthcheck and signed #213/#214 authorization chain remain mandatory.

After `CUTOVER_STARTED`, retries use authenticated switch intent, durable journal, execution events, and actual mount identities. They must not pretend that the pre-cutover rollback-set condition is still true after candidate selection.

## Scope boundary

The execution core itself still contains no Docker invocation. Operational read-only assessment and event persistence are provided separately by #216.

A future mutating executor must:

1. create/reuse the durable journal,
2. obtain `READY_TO_START`,
3. persist `CUTOVER_STARTED` before mutation,
4. converge only to journal-bound candidate volumes,
5. persist `CANDIDATE_SELECTED` only after exact candidate mount identity is proven,
6. persist `ROLLBACK_STARTED` before any rollback mutation,
7. converge rollback only to journal-bound rollback volumes,
8. never delete either volume set during cutover,
9. use health verification before terminal evidence.

No code in this document changes `PRIVACY_BACKUP_STATE`.
