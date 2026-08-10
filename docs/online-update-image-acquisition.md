# Online Update Image Acquisition v1

## Purpose

This is the first bounded external side-effect in the online-update chain. It may only acquire the exact immutable APP and MIGRATOR images already bound by the verified execution journal.

It does not stop or restart services, invoke Docker Compose, run migrations, modify volumes, restore backups, or touch application data.

## Required evidence

The executor first authenticates the HMAC-signed `online-update-execution-journal.json` and the existing append-only execution-event chain.

A fresh execution must have no events. A retry may begin only when the latest event is:

- `IMAGE_ACQUISITION_STARTED`, or
- `IMAGES_ACQUIRED`.

Any later phase is rejected because image acquisition is no longer the active bounded capability.

## Pre-side-effect evidence

Before the first `docker pull`, the executor persists:

```text
IMAGE_ACQUISITION_STARTED
```

If a pull or local verification then fails, no success event is written. A retry sees exactly the durable started state and may safely repeat acquisition of the same immutable digest.

## Allowed Docker surface

The executor is limited to:

```text
docker pull <journal-bound repo@sha256:digest>
docker image inspect <same exact reference>
```

No tag-only reference is accepted. Every journal image must contain `@sha256:`.

After each pull, the executor requires Docker image inspection to expose the exact journal-bound reference in `RepoDigests`. The local image must also expose a valid `sha256:` image ID.

Only after both APP and MIGRATOR pass this local identity check is:

```text
IMAGES_ACQUIRED
```

persisted in the signed event chain.

## Retry after cache loss

`IMAGES_ACQUIRED` records that the exact images were successfully acquired and verified at least once. It does not assume Docker cache permanence.

If the executor is retried while `IMAGES_ACQUIRED` is already current, it re-verifies both exact references. If a local image is missing, the same digest-pinned reference may be pulled again. The existing `IMAGES_ACQUIRED` event is reused and no later execution phase is created.

This reacquisition is safe because it cannot change production runtime state and the reference is immutable.

## Failure semantics

If the registry is unavailable, a digest does not exist, pull fails, inspect output is invalid, or the exact RepoDigest is absent, execution fails with only `IMAGE_ACQUISITION_STARTED` present.

No automatic `ABORTED_BEFORE_PRODUCTION_MUTATION` event is written. An orchestrator may explicitly choose that terminal transition, or retry acquisition while production is still untouched.

## Output

Successful output mode:

```text
CLUB_ONLINE_UPDATE_IMAGE_ACQUISITION_V1
```

Status:

```text
EXACT_IMAGES_ACQUIRED
```

The output reports the target version, exact references, local image IDs and RepoDigests, event reuse/creation, and confirms:

- `productionMutationStarted=false`
- `migrationStarted=false`
- `updateExecuted=false`

## CI proof

The server contract uses a disposable local OCI registry and two scratch images built specifically for the test. It proves:

- exact digest-bound acquisition,
- local RepoDigest verification before success evidence,
- successful cache-loss reacquisition without event advancement,
- failed pull leaves only `IMAGE_ACQUISITION_STARTED`,
- the executor source contains no Compose/service/migration/volume/restore path.

## Next boundary

The next safe slice is **not** migration. It is a read-only pre-stop assessment that proves the two exact images remain locally available, verifies the journal/event chain is at `IMAGES_ACQUIRED`, and captures the currently running application-writer identity before any `WRITER_STOP_STARTED` event or service mutation.
