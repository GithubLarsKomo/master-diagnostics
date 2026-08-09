# Restore Promotion Switch Assessment v1

## Purpose

The post-cutover assessment layer authenticates immutable switch evidence and classifies actual Docker mount identity without re-running the pre-cutover candidate healthcheck.

It remains operationally read-only. A separate event writer may append signed execution evidence, but neither component changes Docker selection or production services.

`PRIVACY_BACKUP_STATE=DISABLED` remains unchanged.

## Trust split

Before the first cutover mutation, the system must still prove the complete #212/#213/#214 chain with the original rollback set active.

After `CUTOVER_STARTED`, recovery proves instead:

```text
HMAC-authenticated switch intent
  -> HMAC-verified durable PENDING journal
  -> HMAC-verified append-only execution events
  -> actual app/libSQL Docker mounts
  -> deterministic execution assessment
```

The existing strict switch-intent reader remains unchanged for pre-cutover use. The post-cutover authenticator proves HMAC authenticity and internal invariants without asserting that rollback volumes are still active.

## Assessment CLI

```bash
pnpm --filter @masters/db backup:restore-promotion-switch-assess
```

Inputs are switch intent, durable journal, execution-event directory, promotion key, and the four actual volume names.

The CLI writes nothing and may return:

- `READY_TO_START`
- `READY_TO_SELECT_CANDIDATE`
- `RECOVER_CANDIDATE_SELECTION`
- `VERIFY_CANDIDATE`
- `READY_TO_SELECT_ROLLBACK`
- `RECOVER_ROLLBACK_SELECTION`
- `VERIFY_ROLLBACK`
- `COMPLETED`
- `ROLLED_BACK`
- `BLOCKED`

Current volumes are separately classified as:

- `ROLLBACK`
- `CANDIDATE`
- `MIXED_KNOWN`
- `UNKNOWN`

`MIXED_KNOWN` means every role uses one of the two journal-authorized names, but the selector transition is incomplete. It is recoverable only when signed execution evidence already establishes the intended direction. `UNKNOWN` is always blocked.

## Host assessment

```bash
bash infra/backup/assess-club-restore-promotion-switch.sh restore-<timestamp>-<uuid>
```

The wrapper uses `docker compose ps -a` so stopped containers remain valid mount evidence during crash recovery. It renders only the base Club Compose stack, inspects one `app` and one `libsql` container, and resolves their actual mounted volume names through the existing role-aware resolver.

It does not call the pre-cutover candidate healthcheck, selector override, event writer, volume mutation, or production service stop/start.

## Signed event writer

```bash
pnpm --filter @masters/db backup:restore-promotion-switch-event
```

Allowed phases now include:

```text
CUTOVER_STARTED
CANDIDATE_SELECTED
COMPLETED
ROLLBACK_STARTED
ROLLBACK_SELECTED
ROLLBACK_VERIFIED
```

`ROLLBACK_STARTED` is required before any future rollback mutation. This is the durable directional marker that makes a crash during partial rollback unambiguous.

The writer modifies only the durable evidence directory and reports `productionMutationApplied=false`.

## Crash-recovery examples

### Partial candidate activation

Evidence:

- `CUTOVER_STARTED` exists,
- some roles already use candidate volumes,
- the remaining roles still use their bound rollback volumes.

Assessment:

```text
READY_TO_SELECT_CANDIDATE / MIXED_KNOWN
```

A future executor may converge the remaining services to the candidate set. No unknown volume is accepted.

### Candidate activation complete, evidence write lost

Evidence:

- `CUTOVER_STARTED` exists,
- all four roles use candidate volumes,
- `CANDIDATE_SELECTED` is missing.

Assessment:

```text
RECOVER_CANDIDATE_SELECTION
```

The missing event may be persisted without selecting candidate volumes again.

### Partial rollback

Evidence:

- `ROLLBACK_STARTED` exists,
- some roles use rollback volumes and others still use candidate volumes.

Assessment:

```text
READY_TO_SELECT_ROLLBACK / MIXED_KNOWN
```

The future executor may converge only toward the journal-bound rollback set.

### Rollback complete, evidence write lost

Evidence:

- `ROLLBACK_STARTED` exists,
- all four roles use rollback volumes,
- `ROLLBACK_SELECTED` is missing.

Assessment:

```text
RECOVER_ROLLBACK_SELECTION
```

The missing rollback event may be persisted without applying rollback a second time.

### Unsafe rollback without directional evidence

If `CANDIDATE_SELECTED` is the last event but rollback volumes appear without prior `ROLLBACK_STARTED`, assessment is `BLOCKED`. The system will not assume whether an external actor changed volumes or an authorized rollback was attempted.

## Isolated services

`backup-restore-promotion-switch-assess` mounts key, intent, and evidence read-only with `network_mode: none`.

`backup-restore-promotion-switch-event` uses the same isolation but mounts only the evidence directory read-write.

Neither has a Docker socket, database, candidate volume, production data volume, or service dependency.

## Scope boundary

Still outside this layer:

- production stop/start,
- selector activation,
- rollback activation,
- candidate/rollback application healthchecks,
- signed final promotion receipt,
- volume cleanup,
- transition of `PRIVACY_BACKUP_STATE`.

A mutating executor must consume these states exactly and may never infer switch direction from naming conventions or an incomplete event trail.
