# Restore Source Provenance v1

## Purpose

A successful restore promotion previously proved that one staged restore had passed reconciliation, health checks, candidate preparation, switch authorization and post-switch health verification. It did not durably preserve the identity of the encrypted backup bundle that originally produced that staging directory.

That gap matters for online-update rollback. The update journal already binds one exact verified pre-update backup by file name and SHA-256. A later rollback receipt must be able to prove that the restore promoted during rollback came from that exact backup rather than from some other independently valid restore.

## Signed staging provenance

Immediately after an encrypted backup has been copied, checksum-verified, authenticated, decrypted, archive-validated and extracted into a new private staging directory, staging now creates:

```text
restore-source-provenance.json
```

The file is written inside the private staging directory only after the original extracted top-level layout has been validated.

The signed record binds:

- provenance version,
- generated restore staging name,
- exact encrypted backup file name,
- exact encrypted bundle SHA-256,
- authenticated backup `createdAt`,
- SHA-256 fingerprint of the authenticated backup manifest,
- bundle version,
- cleanly-stopped consistency policy,
- restore-reconciliation requirement,
- exact six backup source names.

The envelope is HMAC-SHA256 signed with the backup encryption key under a separate domain:

```text
masters:backup-restore-source-provenance:v1
```

Domain separation prevents the HMAC from being confused with backup encryption or any other evidence signature.

## Persistence and validation

- staging directory remains private (`0700`),
- provenance file is exclusive-create (`wx`) and `0600`,
- symlink/non-regular provenance files are rejected,
- the backup key must still decode to exactly 32 bytes,
- record fields and source order are validated before signing and after reading,
- HMAC comparison is constant-time,
- modified file name, bundle SHA, manifest fingerprint, staging identity or policy invalidates the signature.

The stage CLI now also returns `sourceProvenancePath` and `sourceProvenanceSignature` so later restore orchestration can bind this identity explicitly.

## Why this precedes the online-update rollback receipt

The current restore completion receipt authenticates the promotion/switch chain, while the online-update journal authenticates the pre-update backup anchor. Without source provenance there is no cryptographic bridge proving that those two chains refer to the same backup.

The next safe slice should consume this provenance in the restore promotion/receipt chain so that the completion receipt transitively binds the exact encrypted bundle identity. Only after that should the online-update rollback receipt be created and used as the prerequisite for `ROLLBACK_COMPLETED`.

## Scope boundary

This slice does not:

- stop or start any service,
- select or mutate Docker volumes,
- restore a backup into production,
- alter restore promotion state,
- create an online-update rollback receipt,
- persist `ROLLBACK_COMPLETED`.

It only preserves authenticated source identity at the point where that identity is still directly known and verified.
