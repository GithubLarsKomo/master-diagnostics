# Restore Promotion Switch Journal v1

## Purpose

The promotion switch journal is the durable crash-recovery boundary between a signed switch authorization and any future production cutover.

This slice does **not** stop production services, switch Docker volumes, create/delete volumes, or declare the restore promoted. It only persists the exact pre-mutation contract that a later executor must consume.

`PRIVACY_BACKUP_STATE=DISABLED` remains unchanged.

## Required predecessor state

Journal preparation is permitted only after the restore promotion chain has produced:

1. a healthy private restore,
2. a signed promotion intent,
3. a signed execution plan bound to the currently active volumes,
4. isolated candidate volumes,
5. a fresh `CANDIDATE_SET_HEALTHY` result,
6. a signed `promotion-switch-intent.json` bound to that candidate-set result.

Immediately before journal creation the host wrapper recomputes the complete candidate-set healthcheck again. The signed switch intent is cryptographically revalidated against that fresh report.

## Durable host location

The journal is deliberately stored outside the mutable private restore workspace.

Default root:

```text
/var/lib/master-diagnostics/restore-promotion-switch-journal
```

Configurable with:

```text
RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_HOST_DIR
```

Each candidate set receives its own directory:

```text
<journal-root>/<candidateSetId>/promotion-switch-journal.json
```

The root and candidate-set directory are `0700`; the journal file is `0600`.

This location must survive container/process failure and must not be removed as part of private restore workspace cleanup.

## PENDING journal record

The signed journal records:

- `journalVersion=1`
- `phase=PENDING`
- stable `startedAt`
- exact signed switch-intent signature and authorization time
- candidate-set fingerprint
- execution-plan fingerprint
- active rollback-volume-set fingerprint
- candidate-set ID
- selector strategy and selector override path
- rollback/caddy/crash-recovery/completion policies
- all four candidate volume names
- all four rollback volume names
- each candidate tree fingerprint
- deterministic `journalFingerprint`
- `journalRequiredBeforeMutation=true`
- `rollbackVolumesMustRemain=true`
- `productionSwitchAuthorized=true`
- `productionMutationStarted=false`
- `promotionExecuted=false`

The envelope is HMAC-SHA256 signed with the promotion key under a separate signing domain:

```text
masters:restore-private-promotion-switch-journal:v1
```

## Idempotency

An existing valid journal bound to the same signed switch intent is reused. Its original `startedAt`, journal fingerprint, and signature remain stable.

A conflicting journal or a newly observed candidate set that no longer matches the signed switch intent fails closed. Journal preparation never rewrites an existing different PENDING record.

## Host command

```bash
bash infra/backup/prepare-club-restore-promotion-switch-journal.sh restore-<timestamp>-<uuid>
```

The wrapper:

1. validates the private restore workspace, switch intent, and promotion key,
2. reruns the complete candidate-set healthcheck,
3. normalizes only the final healthy machine-readable report,
4. derives the candidate-set ID from that report,
5. creates/verifies the durable host journal directory,
6. runs the isolated journal service with the healthcheck and switch intent mounted read-only,
7. persists or reuses the signed PENDING journal.

It contains no `docker volume create`, `docker volume rm`, `docker cp`, production `compose stop/down/up/restart`, or selector invocation.

## Isolated journal service

`backup-restore-promotion-switch-journal` has:

- promotion HMAC key read-only,
- durable candidate-set journal directory read-write,
- fresh candidate healthcheck as a dynamic read-only mount,
- signed switch intent as a dynamic read-only mount,
- `network_mode: none`,
- no Docker socket,
- no database,
- no private restore workspace mount,
- no candidate or rollback Docker volume mount,
- no dependency on production services.

## Selector contract

`infra/docker-compose.restore-promotion-selector.yml` is the only selector definition introduced in this slice.

It overrides exactly four logical club data volumes:

- `libsql-data`
- `report-data`
- `export-data`
- `data-subject-delivery-data`

Each becomes an explicitly named `external: true` Docker volume supplied by environment variables.

The override does not define services and does not override:

- `caddy-data`
- `caddy-config`

Therefore the same selector contract can later render either:

- the four journal-bound candidate volume names for cutover, or
- the four journal-bound rollback volume names for rollback.

Rendering the selector does not create, delete, or attach a volume by itself.

## Crash and rollback invariant

A future mutating executor may not start production mutation unless it has first revalidated:

1. fresh candidate healthcheck,
2. signed switch intent,
3. signed PENDING journal,
4. exact candidate and rollback volume identities,
5. exact selector rendering.

The first production mutation must occur **after** durable journal persistence. If cutover cannot be proven healthy, the executor must reselect the four journal-bound rollback volumes; it must not guess names from conventions or delete the rollback set.

## Still out of scope

This slice intentionally does not implement:

- production downtime,
- service stop/start,
- candidate selector activation,
- rollback execution,
- post-switch healthcheck,
- signed switch completion receipt,
- cleanup of rollback or candidate volumes,
- transition of `PRIVACY_BACKUP_STATE` away from `DISABLED`.

The next safe slice is a bounded mutating switch executor with explicit phase transitions and crash/retry handling. It must consume this journal rather than recomputing an intended volume set after mutation has begun.
