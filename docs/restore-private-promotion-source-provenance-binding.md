# Restore promotion source-provenance binding

## Purpose

The private restore promotion chain must retain a cryptographic answer to one question after a successful cutover:

> Which exact encrypted `.mdbak` backup produced the promoted data set?

Restore staging already persists `restore-source-provenance.json`, signed under the backup-key domain. The promotion switch uses a separate promotion HMAC key and durable switch evidence outside the mutable restore workspace. This slice bridges those domains without weakening key separation or broadening the production-mutation boundary.

## Durable artifact

Before the PENDING switch journal is created, the host wrapper persists:

`<RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_HOST_DIR>/<candidateSetId>/promotion-source-provenance-binding.json`

The directory remains `0700`; the binding file is `0600` and immutable/idempotent.

The signed record binds:

- staging name,
- source-provenance HMAC signature,
- encrypted backup file name,
- encrypted backup SHA-256,
- backup creation time,
- backup manifest fingerprint,
- authenticated promotion switch-intent signature,
- execution-plan fingerprint,
- candidate-set ID,
- candidate-set fingerprint,
- `productionMutationAllowed=false`,
- `promotionExecuted=false`.

The binding uses its own promotion-key signing domain:

`masters:restore-private-promotion-source-provenance-binding:v1`

## Key separation

Two independent keys are required and serve different purposes:

1. `BACKUP_KEY_FILE` verifies `restore-source-provenance.json`, which was signed during staging with the backup encryption/provenance key.
2. `RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE` authenticates the switch intent and signs the durable promotion binding.

The backup key is never reused as the promotion HMAC key. The promotion key is never used to authenticate the encrypted backup bundle itself.

## Host ordering

`prepare-club-restore-promotion-switch-journal.sh` now enforces this order:

1. recompute the complete read-only candidate-set healthcheck,
2. resolve the candidate-set ID,
3. create/verify the durable candidate-set evidence directory,
4. verify source provenance and authenticated switch intent and persist the source-provenance binding,
5. require the canonical binding file to exist,
6. persist the existing PENDING switch journal.

No production service is stopped and no application data volume is created, removed, copied or reselected by the binding step.

## Isolated binding service

`backup-restore-promotion-source-provenance-bind` runs with `network_mode: none`.

Static mounts are limited to:

- backup key: read-only,
- promotion key: read-only,
- candidate-set durable evidence directory: read-write.

The host wrapper adds exactly two dynamic read-only mounts:

- the staged `restore-source-provenance.json`,
- the authenticated `promotion-switch-intent.json`.

The service has no Docker socket, private replay workspace, candidate volume or production data volume.

## Completion receipt binding

A Promotion Switch Completion Receipt now requires the verified source-provenance binding in addition to the switch journal, signed execution-event chain and healthy post-switch report.

The receipt's signed record carries:

- source-provenance binding signature and fingerprint,
- original source-provenance signature,
- source staging name,
- encrypted backup file name and SHA-256,
- backup creation time,
- backup manifest fingerprint.

The binding's plan fingerprint, candidate-set ID and candidate-set fingerprint must match the durable switch journal. A valid binding for another valid restore or candidate set cannot be substituted.

The read-only completion-receipt verifier emits these fields after successful HMAC verification, providing a stable authenticated input for the subsequent online-update rollback receipt.

## Failure semantics

The operation fails closed when any of the following is true:

- the source provenance is missing, symlinked, malformed or signed by another backup key,
- the switch intent is missing, malformed or fails promotion-key authentication,
- source provenance describes another staging identity,
- the durable binding already exists but refers to another switch intent or backup source,
- the binding HMAC or internal fingerprint is invalid,
- the Completion Receipt receives a binding whose plan/candidate identity differs from the switch journal.

A failure does not mutate production state.

## Scope boundary

This slice does **not** implement an online-update rollback receipt and does not add a new production mutation. It only makes the exact encrypted restore source a transitive, signed property of successful promotion completion evidence.

The next safe slice is an online-update rollback receipt that binds `ROLLBACK_STARTED`, the online update's pre-update encrypted backup identity, and the authenticated restore completion receipt. The receipt must prove that the promoted rollback source is the same exact backup selected before the update.
