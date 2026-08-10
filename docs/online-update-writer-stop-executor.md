# Online Update Writer-Stop Executor v1

## Purpose

This slice implements the first online-update **production mutation** after the immutable image-acquisition and pre-stop evidence chain.

It stops only the exact application-writer containers bound by the signed Writer-Stop Intent from the previous slice. It does not run migrations, start the target application, restore a backup, or mark the update complete.

## Required evidence

The executor requires:

- HMAC-verified Online Update Execution Journal,
- HMAC-verified append-only execution-event chain,
- current phase `IMAGES_ACQUIRED`, `WRITER_STOP_STARTED`, or `WRITERS_STOPPED`,
- HMAC-verified Writer-Stop Intent,
- exact binding of that intent to the original `IMAGES_ACQUIRED` event,
- Club Compose file and environment file.

Before the **first** production mutation, when the current event is still `IMAGES_ACQUIRED`, the executor reruns the complete read-only pre-stop assessment. The fresh result must match the durable Writer-Stop Intent exactly.

## Durable mutation boundary

The required order is:

```text
fresh pre-stop assessment
  -> verify durable writer-stop intent
  -> WRITER_STOP_STARTED
  -> stop exact intent-bound writer container IDs
  -> verify every bound writer is stopped
  -> verify libSQL is still running and healthy
  -> WRITERS_STOPPED
```

`WRITER_STOP_STARTED` is persisted before the first `docker stop` call.

## Exact stop scope

The executor never derives a new writer target after mutation begins. It uses only the writer identities already signed into the Writer-Stop Intent:

- Compose project,
- service name,
- full container ID,
- image ID,
- configured image reference,
- original `StartedAt` identity.

Immediately before stopping each container, those values are rechecked with `docker inspect`. `docker compose ps -q <service>` must either resolve the same bound running container or, on retry, no running container at all.

A replacement container, changed image identity, changed start identity, ambiguous service instance, or unknown container blocks execution.

The only Docker mutation allowed in this slice is:

```text
docker stop <exact-bound-container-id>
```

libSQL is never a stop target.

## libSQL invariant

After all application writers are stopped, the executor requires exactly one running `libsql` container in the same Compose project. It must be both:

- `Running=true`,
- Docker health status `healthy`.

Only then may `WRITERS_STOPPED` be persisted.

## Crash and retry

The executor serializes runs with an exclusive `flock` in the execution-event directory.

A process crash after `WRITER_STOP_STARTED` is retryable. Already stopped bound containers are recognized from their original container identity and are not stopped a second time. Remaining bound writers are then stopped and the executor can continue to `WRITERS_STOPPED`.

This is intentionally different from a **detected** execution error. A process crash is not itself evidence that rollback is required; a subsequent retry first reconstructs the actual state.

## Detected failure after production mutation begins

From `WRITER_STOP_STARTED` onward, the existing execution-event contract requires every controlled non-success path to enter rollback evidence.

Therefore, if the executor detects a bounded failure after the production-mutation boundary—for example:

- a writer identity mismatch,
- a stop command failure,
- a replacement writer container,
- libSQL no longer running or healthy,
- unexpected event advancement,

it persists:

```text
ROLLBACK_STARTED
```

before returning failure whenever the current event chain legally allows it.

This slice does **not** claim `ROLLBACK_COMPLETED` and does not restore the backup. The verified pre-update backup rollback itself remains a separate subsequent slice.

## Bounded external surface

The executor allows only:

- `docker inspect <id>`,
- `docker compose ... ps -q <service>`,
- `docker stop <exact-bound-writer-id>`.

Docker operations and the fresh pre-stop subprocess are bounded by a 30-second timeout per invocation.

It contains no:

- image pull,
- Compose `up`, `down`, `restart`,
- volume mutation,
- migration execution,
- backup restore,
- application start,
- completion receipt.

## Server contract

`Online Update Writer-Stop Executor Contract` uses only a stateful fake Docker surface and authentic HMAC journal/event/intent evidence. It proves:

1. exact three-writer stop and healthy libSQL preservation,
2. idempotent retry after `WRITERS_STOPPED`,
3. a real SIGKILL of the executor process after the first stop followed by successful continuation without re-stopping that container,
4. libSQL-health failure after writer mutation produces `ROLLBACK_STARTED` but never `WRITERS_STOPPED` or `ROLLBACK_COMPLETED`,
5. mutation surface remains limited to exact writer `docker stop`.

## Next safe slice

The next slice should implement the rollback executor for the already journal-bound verified pre-update backup. It must consume `ROLLBACK_STARTED`, restore in a crash-safe isolated sequence, verify the pre-update application state, and only then persist `ROLLBACK_COMPLETED`.

The normal success path remains paused at `WRITERS_STOPPED`; controlled migration is still a separate later slice.
