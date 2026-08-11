# Online Update Rollback Receipt v1

## Purpose

The rollback receipt closes the evidence gap between an online-update rollback decision and a successfully completed restore of the exact pre-update backup.

It is created only after the online-update event chain has reached:

```text
ROLLBACK_STARTED
```

and after the existing read-only restore-promotion completion verifier has independently authenticated a completed restore.

This slice is evidence-only. It does not restore a backup and does not persist `ROLLBACK_COMPLETED`.

## Required identity equality

The online-update execution journal already binds the verified pre-update backup as `rollbackAnchor`:

- exact `.mdbak` file name,
- SHA-256 of the encrypted bundle bytes,
- backup `createdAt`.

The restore-promotion completion receipt now transitively carries the exact source backup identity through the signed source-provenance binding.

The rollback receipt is permitted only when all three fields are exactly equal:

```text
restore source backup fileName  == online-update rollbackAnchor fileName
restore source backup sha256    == online-update rollbackAnchor sha256
restore source backup createdAt == online-update rollbackAnchor createdAt
```

A successful restore of any other authentic backup is therefore insufficient.

## Verification chain

The writer verifies the online-update side with the existing Python readers:

```text
Online Update Execution Journal HMAC
  -> append-only Online Update Execution Event HMAC chain
  -> current event exactly ROLLBACK_STARTED
```

The restore side is deliberately not reimplemented in Python. The writer invokes the existing read-only command:

```bash
pnpm --silent --filter @masters/db \
  backup:restore-promotion-switch-completion-receipt-verify
```

That verifier authenticates:

```text
Switch Intent HMAC
  -> Source Provenance Binding HMAC
  -> Switch Journal HMAC
  -> Switch Execution Event HMAC chain
  -> Promotion Completion Receipt HMAC
```

The resulting verification output contains the source backup identity introduced by #268/#269.

## Receipt record

`online-update-rollback-receipt.json` binds at minimum:

- online-update execution-journal signature,
- exact `ROLLBACK_STARTED` event signature,
- update target version,
- rollback backup file name/SHA/createdAt,
- verified restore completion receipt signature,
- restore completion timestamp,
- source-provenance binding signature and fingerprint,
- source-provenance signature and staging identity,
- restore candidate-set identity,
- post-switch healthcheck fingerprint,
- `rollbackReceiptRequiredBeforeRollbackCompleted=true`,
- `rollbackCompleted=false`,
- `updateExecuted=false`.

The record has its own SHA-256 `receiptFingerprint`.

## Signing domain

The receipt uses a separate HMAC domain:

```text
masters:club-online-update-rollback-receipt:v1
```

The key must decode to exactly 32 bytes. Operational wiring should provision a dedicated rollback-receipt key rather than reuse the online-update journal/event, backup, or restore-promotion keys.

## Persistence

- target directory: `0700`,
- receipt file: `0600`,
- regular non-symlink paths only,
- exclusive create,
- identical retry reuses the existing envelope,
- a conflicting retry is fail-closed,
- HMAC and content fingerprint are both verified on read.

The canonical file name is:

```text
online-update-rollback-receipt.json
```

## Time ordering

The receipt timestamp must satisfy:

```text
recordedAt >= ROLLBACK_STARTED.recordedAt
recordedAt >= restore completion completedAt
```

It cannot retrospectively claim a restore that had not completed yet.

## Current safety boundary

This slice deliberately does **not** modify the existing online-update event transition logic yet.

Therefore:

- it does not execute a restore,
- it does not write `ROLLBACK_COMPLETED`,
- it contains no Docker/Compose/volume/service mutation,
- it does not duplicate restore HMAC domains,
- it only creates durable proof that the journal-bound rollback backup was actually restored and promoted successfully.

The next safe slice makes this receipt mandatory evidence before the event writer can persist terminal `ROLLBACK_COMPLETED`.
