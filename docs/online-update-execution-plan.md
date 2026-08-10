# Online Update Execution Plan v1

## Purpose

The execution plan is the final immutable planning artifact before an online update may acquire image layers or change the running Club deployment. It combines the already verified preparation and registry-resolution evidence into one deterministic, HMAC-signed instruction set.

This stage remains non-mutating.

## Inputs

The plan requires and HMAC-verifies:

- `online-update-preparation.json`, including the exact release notes and verified post-selection rollback backup,
- `online-update-image-resolution.json`, including exact APP and MIGRATOR registry descriptor identities.

The resolution evidence must be bound to the exact preparation signature, manifest fingerprint, target version and image references supplied to the plan. Cross-evidence mixing fails closed.

## Fixed execution order

The only v1 order is:

```text
ACQUIRE_EXACT_IMAGES
STOP_APPLICATION_WRITERS
RUN_CONTROLLED_MIGRATIONS
START_APPLICATION
VERIFY_APPLICATION_HEALTH
COMPLETE_UPDATE
```

This keeps image acquisition before downtime, prevents migrations while application writers are active, and requires health verification before completion.

## Rollback anchor

The plan carries the exact verified pre-update backup file name, SHA-256 and creation time from preparation evidence. That backup is explicitly marked as the rollback anchor.

Policy remains:

```text
RESTORE_VERIFIED_PREUPDATE_BACKUP
```

Any failure after application writers are stopped and before successful completion requires the rollback path.

## Health and evidence policy

Completion requires:

- application health,
- database health,
- required background services,
- the running application version to equal the target version.

Before the first mutating action a separate durable execution journal is mandatory. A successful update requires a completion receipt after the healthcheck. A rollback requires a rollback receipt.

## Signed evidence

Canonical file:

```text
online-update-execution-plan.json
```

Signing domain:

```text
masters:club-online-update-execution-plan:v1
```

The plan contains no generated timestamp. Identical verified inputs therefore create deterministic record bytes and an identical signature; retries reuse the existing evidence.

Permissions are `0700` for the evidence directory and `0600` for the file.

## Safety boundary

Planning does not authorize mutation. These flags remain false:

```text
imagePullAllowed=false
migrationAllowed=false
productionMutationAllowed=false
updateExecuted=false
```

The next slice should create a durable signed update execution journal before any image acquisition or production change. Only a later executor may consume plan + journal and perform bounded update steps with crash/retry recovery.
