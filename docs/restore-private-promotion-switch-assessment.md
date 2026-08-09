# Restore Promotion Switch Assessment v1

## Purpose

This slice makes the #215 crash/retry state machine operational **read-only** without weakening the pre-cutover safety gate.

It introduces two separate capabilities:

1. authenticated post-cutover assessment of switch state from immutable evidence plus actual Docker mount identity,
2. a signed execution-event writer that modifies only the durable switch evidence directory and never production state.

No host command in this slice changes Docker volume selection, stops or starts production services, or marks a promotion complete.

`PRIVACY_BACKUP_STATE=DISABLED` remains unchanged.

## Two different trust questions

Before the first cutover mutation, the system must still prove:

- the private restore is healthy,
- the candidate set is healthy,
- the original rollback volume set is still the active set,
- the signed execution plan, switch intent, and durable PENDING journal all match that fresh state.

That remains the job of the existing pre-cutover chain, including #212.

After a selector change, the statement “the original rollback set is still active” is intentionally no longer true. Recovery therefore must not rerun the pre-cutover healthcheck and interpret that expected difference as evidence corruption.

Post-cutover recovery instead proves:

```text
HMAC-authenticated switch intent
  -> HMAC-verified durable PENDING journal
  -> HMAC-verified append-only execution events
  -> actual current app/libSQL Docker mounts
  -> deterministic #215 assessment
```

## Post-cutover switch intent authentication

`readAuthenticatedRestorePrivatePromotionSwitchIntent(...)` verifies:

- expected file name and non-symlink regular-file semantics,
- envelope and record version,
- canonical authorization timestamp,
- all required safety-policy constants,
- candidate-set / plan / rollback-set fingerprint formats,
- candidate-set identity,
- exact ordered four-role candidate/rollback mapping,
- candidate and rollback volume set uniqueness/disjointness,
- HMAC-SHA256 under the existing switch-intent signing domain.

This function intentionally does **not** assert that rollback volumes are currently active. It authenticates immutable authorization evidence after a cutover.

The existing `readVerifiedRestorePrivatePromotionSwitchIntent(..., healthcheck)` remains unchanged and stronger. It is still required where a fresh pre-cutover candidate healthcheck must be bound to the intent.

## Durable journal and event authentication

The authenticated intent is passed to the existing signed journal reader, which verifies the #214 journal HMAC and its exact binding to the intent.

The verified journal is then passed to the #215 event reader, which verifies:

- event HMACs,
- event-to-journal binding,
- previous-event signature chain,
- legal phase transitions,
- terminal-state consistency.

## Read-only assessment CLI

```bash
pnpm --filter @masters/db backup:restore-promotion-switch-assess
```

Inputs:

- switch-intent file,
- durable switch-journal file,
- durable execution-event directory,
- promotion HMAC key,
- four currently active Docker volume names.

Output mode:

```text
ISOLATED_RESTORE_PROMOTION_SWITCH_EXECUTION_ASSESSMENT
```

The output exposes the #215 state such as:

- `READY_TO_START`
- `READY_TO_SELECT_CANDIDATE`
- `RECOVER_CANDIDATE_SELECTION`
- `VERIFY_CANDIDATE`
- `RECOVER_ROLLBACK_SELECTION`
- `VERIFY_ROLLBACK`
- `COMPLETED`
- `ROLLED_BACK`
- `BLOCKED`

The CLI writes nothing.

## Host assessment

```bash
bash infra/backup/assess-club-restore-promotion-switch.sh restore-<timestamp>-<uuid>
```

The wrapper:

1. validates the private restore workspace, switch intent, promotion key, and durable journal location,
2. uses the candidate-set ID from the intent only to locate the evidence directory, with strict format validation,
3. renders the base Club Compose file read-only,
4. resolves one existing `app` container and one existing `libsql` container with `docker compose ps -a`, including stopped containers,
5. reads their mounts with `docker inspect`,
6. resolves the four actual active/bound data volume names with the existing role-aware resolver,
7. runs the isolated assessment container with those names.

Using `ps -a` is intentional. If a future cutover stops the rollback-bound containers and the host crashes before candidate-bound replacements are created, the stopped containers still provide exact mount evidence. If there is no unique container identity, assessment fails closed.

The wrapper does not invoke:

- #212 candidate healthcheck,
- selector Compose override,
- `docker volume create/rm`,
- `docker cp`,
- production `compose stop/down/up/restart`,
- execution-event writer.

## Isolated assessment service

`backup-restore-promotion-switch-assess` has only:

- promotion key read-only,
- switch intent read-only,
- switch evidence directory read-only,
- `network_mode: none`,
- no Docker socket,
- no database,
- no candidate or production data-volume mount,
- no service dependency.

## Signed event writer

```bash
pnpm --filter @masters/db backup:restore-promotion-switch-event
```

with one explicit phase in:

```text
RESTORE_PRIVATE_PROMOTION_SWITCH_EVENT_PHASE
```

The event writer:

- authenticates switch intent,
- verifies durable journal,
- verifies existing execution-event chain,
- persists only the next legal signed event,
- modifies only the durable switch evidence directory,
- reports `productionMutationApplied=false`.

The isolated `backup-restore-promotion-switch-event` service has the same minimal inputs as assessment, except that the evidence directory is writable. It still has no Docker socket, production volume, database, or network.

The read-only host assessment never calls this service.

## Crash-recovery examples

### Candidate selector applied, evidence write lost

Evidence:

- `CUTOVER_STARTED` exists,
- current live/stopped mounts are exactly the candidate set,
- `CANDIDATE_SELECTED` does not yet exist.

Assessment:

```text
RECOVER_CANDIDATE_SELECTION
```

A future executor may persist the missing `CANDIDATE_SELECTED` event without changing the selector again.

### Rollback applied, rollback evidence write lost

Evidence:

- `CANDIDATE_SELECTED` exists,
- current mounts are exactly the rollback set,
- `ROLLBACK_SELECTED` does not yet exist.

Assessment:

```text
RECOVER_ROLLBACK_SELECTION
```

A future executor may persist the missing rollback event without applying rollback a second time.

### Mixed volume identity

If the four mounts do not exactly match either the journal-bound candidate set or rollback set:

```text
BLOCKED / ACTIVE_VOLUME_SET_MIXED_OR_UNKNOWN
```

No automatic repair is inferred.

## Scope boundary

Still not implemented:

- production stop/start,
- selector activation,
- rollback activation,
- candidate application healthcheck,
- rollback application healthcheck,
- signed final promotion receipt,
- rollback-volume cleanup,
- `PRIVACY_BACKUP_STATE` transition.

The next safe slice can implement a bounded mutating executor because all pre-mutation authorization and post-crash state reconstruction primitives are now explicit. That executor must consume these APIs and may never infer switch state from naming conventions alone.
