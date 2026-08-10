# Online Update Preflight v1

## Purpose

This is the first bounded slice of the Club online-update workflow from SPEC §41. It validates an explicitly selected target release **before any network pull or production mutation**.

The preflight is intentionally read-only. It does not pull images, create a backup, migrate a database, stop or recreate services, write `.env`, or mark an update successful.

## Required release manifest

`infra/update/preflight-online-update.py` accepts a local JSON manifest and the currently installed application version.

Version 1 requires exactly:

- `manifestVersion: 1`
- `channel: stable`
- a semantic `releaseVersion`
- release-note title, absolute HTTPS URL, and SHA-256 fingerprint
- exactly two registry images:
  - `APP`
  - `MIGRATOR`
- both images pinned to immutable `@sha256:<digest>` references
- `migrationPolicy: CONTROLLED_MIGRATIONS_BEFORE_APP_START`
- `backupPolicy: VERIFIED_PREUPDATE_BACKUP_REQUIRED`
- `rollbackPolicy: RESTORE_VERIFIED_PREUPDATE_BACKUP`
- `autoUpdate: false`

Unknown or missing manifest fields fail closed.

## Version rules

The preflight refuses:

- the current version again,
- downgrades,
- moving a stable installation to a prerelease,
- malformed semantic versions.

The first implementation supports only the `stable` update channel.

## Output

A valid manifest produces:

```text
mode=CLUB_ONLINE_UPDATE_PREFLIGHT_V1
status=READY_FOR_VERIFIED_BACKUP
```

The output contains a deterministic SHA-256 fingerprint of the canonical manifest plus the exact target image references and release-note metadata.

Even on success it explicitly returns:

- `verifiedBackupRequiredBeforeMutation=true`
- `imagePullAllowed=false`
- `migrationAllowed=false`
- `productionMutationAllowed=false`
- `autoUpdateAllowed=false`
- `updateExecuted=false`

So this preflight is **not** update authorization. It is only the immutable input boundary for the next slice.

## Why image digests are mandatory

Tags such as `latest`, `1.1`, or even `1.1.0` can be moved in a registry. The operational update plan must bind the exact bytes selected by the operator. Therefore v1 accepts only fully qualified registry references ending in `@sha256:<64 hex>`.

## Release notes

The manifest binds release notes by both an HTTPS location and SHA-256 fingerprint. The preflight does not fetch them. A later preparation step must retrieve/display the notes and verify the bytes against this fingerprint before mutation is authorized.

## Backup boundary

SPEC §41 requires a backup to be created and checked before images are loaded/imported and before migrations run. Accordingly, the next mutating-capable update slice must consume:

1. this validated manifest identity,
2. a newly created and successfully verified pre-update backup identity,
3. an explicit operator selection/authorization.

No later executor may infer that an old backup is sufficient merely because one exists.

## Rollback boundary

The declared rollback policy is `RESTORE_VERIFIED_PREUPDATE_BACKUP`. A failed update must therefore use the documented restore path and its existing privacy reconciliation/healthcheck/promotion controls rather than inventing an in-place database downgrade.

## No automatic updates

Unattended automatic updates are explicitly forbidden by SPEC §41.3. The v1 manifest must contain `autoUpdate: false`, and successful preflight still requires a later explicit operator action.

## Example

`infra/update/online-update-manifest.example.json` is schema-shaped documentation only. Its placeholder digests are not a publishable release.
