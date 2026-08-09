# Restore Promotion Switch Execution Evidence v1

## Purpose

This slice defines the crash/retry evidence protocol for a later production restore cutover. It deliberately does **not** implement a host executor, Docker service stop/start, selector activation, rollback execution, or a post-switch completion command.

The goal is narrower: once the durable PENDING switch journal exists, every future mutating cutover must leave an append-only signed trail that lets a retry distinguish what actually happened from what was merely intended.

`PRIVACY_BACKUP_STATE=DISABLED` remains unchanged.

## Why the PENDING journal is not enough

The #214 journal proves what candidate and rollback volume sets were authorized before mutation. It cannot by itself prove whether a host crashed:

- before any cutover mutation,
- after the candidate set became active but before evidence was persisted,
- after candidate verification failed and rollback already became active,
- after a successful cutover but before terminal evidence was written.

Recomputing intent after those points would be unsafe. Recovery must combine immutable pre-cutover evidence with the **actual current mounted volume set** and an append-only execution trail.

## Signed execution events

Execution events use the promotion HMAC key with a separate signing domain:

```text
masters:restore-private-promotion-switch-execution-event:v1
```

The allowed phases are:

1. `CUTOVER_STARTED`
2. `CANDIDATE_SELECTED`
3. either `COMPLETED` or `ROLLBACK_SELECTED`
4. after rollback only: `ROLLBACK_VERIFIED`

No other transition is legal.

Each event binds:

- event version and fixed sequence,
- phase and canonical timestamp,
- journal fingerprint and journal signature,
- candidate-set ID,
- previous event signature,
- selected volume set (`CANDIDATE` or `ROLLBACK`),
- `productionMutationStarted=true`,
- terminal state,
- `promotionExecuted=true` only for `COMPLETED`.

The fixed event filenames are:

```text
promotion-switch-cutover-started.json
promotion-switch-candidate-selected.json
promotion-switch-completed.json
promotion-switch-rollback-selected.json
promotion-switch-rollback-verified.json
```

Events are exclusive-create, `0600`, and chained through `previousEventSignature`. The execution directory is `0700`.

## Deterministic recovery assessment

`assessRestorePrivatePromotionSwitchExecution(...)` compares:

- the verified durable journal,
- the verified signed event chain,
- the four currently active Docker volume names.

Only an exact four-volume match is accepted. A mixed or unknown active set is always `BLOCKED`.

Key states:

| Evidence | Active set | Assessment |
| --- | --- | --- |
| no execution events | rollback | `READY_TO_START` |
| `CUTOVER_STARTED` | rollback | `READY_TO_SELECT_CANDIDATE` |
| `CUTOVER_STARTED` | candidate | `RECOVER_CANDIDATE_SELECTION` |
| `CANDIDATE_SELECTED` | candidate | `VERIFY_CANDIDATE` |
| `CANDIDATE_SELECTED` | rollback | `RECOVER_ROLLBACK_SELECTION` |
| `ROLLBACK_SELECTED` | rollback | `VERIFY_ROLLBACK` |
| `ROLLBACK_VERIFIED` | rollback | `ROLLED_BACK` |
| `COMPLETED` | candidate | `COMPLETED` |

The two `RECOVER_*` states explicitly cover crashes in the narrow interval between a real selector change and persistence of the corresponding evidence event. Recovery must persist the missing evidence step only after the live mount identity proves that the selector change already happened.

Terminal evidence conflicting with the current active volume set is `BLOCKED`, never silently repaired.

## Critical trust-boundary limitation

This slice intentionally exposes only a library API and tests. It does **not** add a host assessment CLI.

Reason: the existing #212 candidate-set healthcheck is a pre-cutover control. Its execution-plan binding requires the original rollback set to still be the current active set. After a successful candidate selector change that condition is intentionally false.

Therefore post-cutover recovery must not rerun #212 as though nothing changed.

Before an operational recovery CLI is added, the switch intent and PENDING journal need an authentication path that verifies their HMAC and internal invariants **without requiring the pre-cutover current-active-volume assertion**. The stronger #212 binding must still be required immediately before the first cutover mutation.

## Out of scope

No code in this slice:

- invokes Docker or Docker Compose,
- stops or starts a production service,
- renders or activates the selector,
- writes a production volume,
- performs rollback,
- performs a post-switch application healthcheck,
- creates a completed promotion receipt,
- changes `PRIVACY_BACKUP_STATE`.

The next safe slice is authenticated post-cutover assessment: separate cryptographic authentication of switch intent/journal from the pre-cutover healthcheck binding, then expose the read-only event/current-volume assessment operationally. Only after that should a mutating switch executor be implemented.
