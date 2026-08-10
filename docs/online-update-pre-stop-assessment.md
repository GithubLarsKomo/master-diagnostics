# Online Update Pre-Stop Assessment v1

## Purpose

This gate is the final **read-only** checkpoint before the online-update workflow is allowed to persist `WRITER_STOP_STARTED` and later stop application writers.

It does not create execution events, stop containers, pull images, run migrations, change volumes, or mutate production state.

## Required state

The assessment requires the authenticated online-update execution chain to end exactly at:

```text
IMAGES_ACQUIRED
```

The current event must still report `productionMutationStarted=false`.

The execution journal and event chain are HMAC-verified with the existing v1 verifiers before Docker state is inspected.

## Target-image revalidation

Both journal-bound immutable image references (`APP` and `MIGRATOR`) are rechecked locally with:

```text
docker image inspect <exact repo@sha256:digest reference>
```

The exact journal-bound reference must appear in `RepoDigests`, and the local image ID must be a SHA-256 image identity.

This prevents the writer-stop boundary from relying only on the earlier acquisition result if the local image cache changed afterward.

## Writer discovery

The assessment renders the canonical Club Compose configuration read-only and derives the set of long-running application writers.

A service is treated as a writer when all of the following hold:

- its rendered `DATABASE_URL` is exactly `http://libsql:8080`,
- it is not a one-shot `restart: "no"` service,
- it is not behind a non-empty Compose profile.

In the current Club stack this derives:

- `app`
- `export-cleanup`
- `retention-scan`

This derivation deliberately excludes one-shot migration and backup jobs while avoiding a hidden hard-coded assumption that only the web application writes to the database.

## Writer identity

For each derived writer service the gate requires exactly one running Compose container and records:

- Compose service name,
- full container ID,
- image ID,
- configured image reference,
- container start timestamp,
- running state.

The container must carry matching `com.docker.compose.project` and `com.docker.compose.service` labels from the rendered Compose project.

A missing, duplicate, stopped, foreign-project, or identity-changing writer blocks the gate.

## Allowed Docker surface

The implementation permits only read-only Docker operations:

- `docker image inspect`
- `docker compose ... config --format json`
- `docker compose ... ps -q <service>`
- `docker inspect <container>`

It contains no pull, stop, start, restart, compose up/down, volume, migration, restore, or execution-event persistence path.

## Output

A successful assessment returns:

```text
mode=CLUB_ONLINE_UPDATE_PRE_STOP_ASSESSMENT_V1
status=READY_FOR_WRITER_STOP_EVIDENCE
```

and includes the authenticated journal/event identity, locally revalidated target images, Compose project, derived writer service list, and exact current writer identities.

Safety flags remain:

- `productionMutationStarted=false`
- `writerStopStarted=false`
- `migrationStarted=false`
- `updateExecuted=false`

## Crash boundary

This report is intentionally ephemeral and read-only. The next mutating slice must re-run the assessment immediately before persisting `WRITER_STOP_STARTED`; it must not treat an old report as authorization after writer/container identity has changed.

Only after `WRITER_STOP_STARTED` is durably persisted may the later executor begin stopping the exact assessed writer set.

## Next safe slice

The next slice should implement the bounded writer-stop stage:

1. re-run this pre-stop assessment,
2. persist `WRITER_STOP_STARTED`,
3. stop only the exact assessed writer services,
4. verify those writers are stopped while libSQL remains available,
5. persist `WRITERS_STOPPED` only after that verification,
6. leave migration for a separate subsequent slice.
