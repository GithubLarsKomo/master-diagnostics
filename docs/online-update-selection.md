# Durable Online Update Selection v1

## Purpose

The online-update preflight proves that a selected release manifest is structurally safe, but it has no time anchor. SPEC §41 requires a backup to be created and verified **before** update mutation. Without a durable selection timestamp, an older valid backup could incorrectly be treated as the pre-update recovery point.

This slice creates immutable local evidence **before** the backup run.

## Command

```bash
python3 infra/update/persist-online-update-selection.py \
  --manifest /absolute/path/update-manifest.json \
  --current-version 1.0.0 \
  --target-dir /var/lib/master-diagnostics/update/<selection> \
  --key-file /etc/master-diagnostics/update.key
```

The key is a dedicated 32-byte random secret encoded as Base64. Example host preparation:

```bash
sudo install -d -m 700 /etc/master-diagnostics
openssl rand -base64 32 | sudo tee /etc/master-diagnostics/update.key >/dev/null
sudo chmod 600 /etc/master-diagnostics/update.key
```

The update key must not be stored in Git or in an update package.

## Revalidation

The selection command loads and executes the existing v1 online-update preflight in-process. It therefore revalidates the exact manifest and current version before any selection evidence is written.

## Signed evidence

The fixed file is:

```text
online-update-selection.json
```

The parent directory is forced to `0700`; the evidence file is created exclusively as `0600`.

The HMAC signing domain is:

```text
masters:club-online-update-selection:v1
```

The signed record binds:

- selection version and `SELECTED` phase,
- canonical UTC `selectedAt`,
- current and target version,
- preflight manifest fingerprint,
- release-notes SHA-256 fingerprint,
- exact APP and MIGRATOR digest references,
- verified-pre-update-backup policy,
- restore-based rollback policy,
- `backupMustBeCreatedAfterSelectedAt=true`,
- all update-mutation permissions still `false`.

## Retry and conflict behavior

If the exact evidence already exists and its HMAC plus manifest/current-version binding verifies, the command reuses it byte-for-byte. It does not create a later timestamp.

If existing evidence is malformed, HMAC-tampered, symlinked, or bound to another manifest/version, the operation fails closed. A different release selection therefore needs a distinct target directory rather than overwriting prior evidence.

## Next boundary

The next preparation step must create a **new** backup and verify it using the established Club backup path. It may only advance if the verified backup's authenticated creation time is at or after this signed `selectedAt` value. It must also fetch/display the bound release notes and verify their bytes against `releaseNotesSha256`.

Only after those two conditions are durably bound to this selection can image pull/import be authorized.

No code in this slice performs backup, network access, Docker commands, migration, service stop/start, or production mutation.
