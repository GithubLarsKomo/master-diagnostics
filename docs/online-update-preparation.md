# Online Update Preparation v1

## Purpose

This stage binds an explicitly selected stable update to the exact release-note bytes and to a freshly created, canonically verified encrypted pre-update backup.

It remains a **pre-mutation** gate. A successful preparation does not authorize image pulls, migrations, service restarts, or production changes.

## Input chain

The preparation consumes:

1. the HMAC-verified `online-update-selection.json` from the selection stage,
2. the exact release-note file bytes,
3. the actual encrypted `.mdbak` backup bytes,
4. JSON emitted by the existing `backup:verify` CLI for that same bundle,
5. a separate 32-byte Base64 HMAC key for preparation evidence.

The selection remains authoritative for target version, manifest fingerprint, image digests, release-note SHA-256, backup policy, and rollback policy.

## Release-note binding

The writer hashes the supplied release-note bytes itself and requires exact equality with the SHA-256 already bound into the signed selection.

A changed file, HTML error page, different release page, encoding change, or other byte difference fails closed.

The preparation records both the SHA-256 and byte count, but not the release-note content itself.

## Fresh pre-update backup binding

The backup must have been verified by the canonical repository backup verifier. The preparation requires the exact v1 verification fields:

- `ok=true`,
- bundle file name,
- SHA-256,
- bundle version,
- `createdAt`,
- `CLEANLY_STOPPED_VOLUMES`,
- `restoreReconciliationRequired=true`.

Freshness is strict:

```text
verified backup createdAt > selection selectedAt
```

Equality is rejected.

The writer additionally hashes the current `.mdbak` bytes itself and requires that hash to equal the canonical verification output. A previously verified bundle that was replaced or modified afterwards cannot be reused.

## Signed preparation evidence

The canonical file is:

```text
online-update-preparation.json
```

Signing domain:

```text
masters:club-online-update-preparation:v1
```

The record binds:

- selection signature,
- selected/current/target version context,
- manifest fingerprint,
- exact APP and MIGRATOR immutable image references,
- release-note SHA-256 and byte count,
- verified backup file name, SHA-256, creation timestamp and consistency contract,
- required backup and rollback policies.

Safety flags remain:

```text
releaseNotesBytesVerified=true
preUpdateBackupVerified=true
preUpdateBackupCreatedAfterSelection=true
imagePullAllowed=false
migrationAllowed=false
productionMutationAllowed=false
updateExecuted=false
```

The evidence directory is forced to `0700`; the evidence file is created exclusively with `0600` permissions. Identical retries reuse the existing signed envelope. Conflicting inputs fail closed and never overwrite the prior evidence.

## Server-side contract

`Online Update Preparation Contract` creates a real encrypted test bundle using `backup:bundle`, verifies it using `backup:verify`, and then persists preparation evidence.

It proves:

- release-note bytes match the signed selection,
- the backup was created strictly after selection,
- canonical verification succeeded,
- current backup bytes still match the verified SHA-256,
- retries are signature-stable,
- release-note tampering fails,
- backup-byte tampering fails,
- stale/equal backup timestamps fail,
- no Docker/registry/update mutation primitives exist in the preparation writer.

## Next gate

The next safe stage may resolve/check the two immutable registry digests and prepare image availability evidence. It must still not mutate the running Club deployment until a later, separately authorized update-execution plan exists.
