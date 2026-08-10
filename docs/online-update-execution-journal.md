# Online Update Execution Journal v1

## Purpose

The online update execution journal is the last durable pre-mutation boundary before an update may acquire images or change production state.

It consumes one HMAC-verified `online-update-execution-plan.json` and persists one HMAC-signed `online-update-execution-journal.json` in a host-durable evidence directory.

The journal does not pull images, run migrations, stop services, start services, contact a registry, or modify production data.

## Bound evidence

The journal binds:

- the execution-plan HMAC signature,
- the SHA-256 of the exact serialized execution-plan envelope,
- manifest fingerprint,
- current and target version,
- exact APP and MIGRATOR immutable image references and digests,
- the verified pre-update backup rollback anchor,
- the fixed six-step execution order.

Binding the exact plan-envelope bytes prevents a later executor from silently substituting a reformatted or otherwise different plan file after execution has begun, even if its semantic record would still verify.

## Initial state

A valid v1 journal is always created in:

```text
phase=PENDING
mutationState=NOT_STARTED
nextStep=ACQUIRE_EXACT_IMAGES
completedSteps=[]
```

All runtime mutation flags are false:

- `imageAcquisitionStarted=false`
- `productionMutationStarted=false`
- `migrationStarted=false`
- `rollbackStarted=false`
- `completionRecorded=false`
- `imagePullAllowed=false`
- `migrationAllowed=false`
- `productionMutationAllowed=false`
- `updateExecuted=false`

The journal therefore proves only that the exact update execution was durably registered before any later side effect.

## Persistence and retry rules

The journal target directory is held at mode `0700`; the journal file is mode `0600`.

Creation is exclusive. A retry may reuse the existing journal only when the requested record is exactly identical, including `startedAt` and the execution-plan byte SHA.

If a journal already exists with a different timestamp, plan bytes, target version, image set, or rollback anchor, creation fails closed. Existing evidence is never overwritten.

`startedAt` is explicit input and must use canonical UTC form such as:

```text
2026-08-10T08:30:00.000Z
```

## Signing domain

The journal uses a separate HMAC domain:

```text
masters:club-online-update-execution-journal:v1
```

A 32-byte base64 key is required. The journal key may be operationally separated from the execution-plan key; both are supplied explicitly.

## CLI

```bash
python3 infra/update/persist-online-update-execution-journal.py \
  --plan /absolute/path/online-update-execution-plan.json \
  --plan-key /absolute/path/online-update-execution-plan.key \
  --target-dir /var/lib/master-diagnostics/online-update/<execution-id> \
  --key-file /etc/master-diagnostics/online-update-execution-journal.key \
  --started-at 2026-08-10T08:30:00.000Z
```

Successful output uses mode:

```text
CLUB_ONLINE_UPDATE_EXECUTION_JOURNAL_V1
```

and status:

```text
PENDING_BEFORE_IMAGE_ACQUISITION_AND_MUTATION
```

## Safety boundary

This slice intentionally stops before the first runtime side effect. A later executor must first authenticate both the execution plan and this journal before it may:

1. acquire the exact immutable images,
2. persist execution progress evidence,
3. stop application writers,
4. run controlled migrations,
5. restart the application,
6. verify target-version health,
7. write a signed completion receipt or execute rollback from the bound backup anchor.

A later executor must not reinterpret `PENDING` as permission to skip intermediate crash-safe evidence. The next safe slice is an append-only signed execution-event protocol for image acquisition and mutation progress.
