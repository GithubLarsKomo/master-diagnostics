# Online Update Writer-Stop Intent v1

## Purpose

The pre-stop assessment is intentionally read-only and ephemeral. Before the first production mutation, the exact assessed writer identities must therefore be persisted durably so a crash after `WRITER_STOP_STARTED` cannot lose which containers were authorized to stop.

This slice persists that authorization evidence but still does **not** stop any service or create any execution event.

## Fresh assessment requirement

Every intent creation or retry first executes the current read-only pre-stop assessment again.

The assessment must still prove:

- HMAC-authenticated execution journal,
- HMAC-authenticated event chain ending at `IMAGES_ACQUIRED`,
- exact APP/MIGRATOR target images locally present by RepoDigest,
- production mutation not started,
- one running container for every dynamically derived long-running application writer.

An existing intent is reusable only when this fresh assessment produces the same bound identities.

## Durable binding

`online-update-writer-stop-intent.json` binds:

- journal HMAC signature,
- exact `IMAGES_ACQUIRED` event HMAC signature,
- target version,
- Compose project identity,
- exact locally verified APP/MIGRATOR image references and image IDs,
- sorted writer service set,
- for every writer:
  - service name,
  - full container ID,
  - current image ID,
  - configured image reference,
  - container start timestamp.

The intent uses a separate HMAC signing domain:

```text
masters:club-online-update-writer-stop-intent:v1
```

and includes a SHA-256 fingerprint over the complete unsigned record.

## Persistence semantics

- target directory: `0700`
- intent file: `0600`
- exclusive create
- existing evidence is never overwritten
- a retry may reuse an existing valid intent even when the caller supplies a later `authorizedAt`
- reuse still requires a fresh assessment whose complete bound identity matches the persisted record
- container/image/start-time drift blocks rather than silently replacing the intent.

This makes the first persisted intent the stable crash-recovery anchor for the later writer-stop stage.

## Safety state

The intent is intentionally pre-mutation evidence:

- `phase=PENDING`
- `writerStopScope=EXACT_ASSESSED_APPLICATION_WRITERS`
- `writerStopEvidenceRequiredBeforeMutation=true`
- `databaseMustRemainAvailable=true`
- `productionMutationAllowed=false`
- `writerStopStarted=false`
- `writersStopped=false`
- `migrationAllowed=false`
- `updateExecuted=false`

The intent alone does not mutate or authorize arbitrary Docker operations.

## Why this is required before `WRITER_STOP_STARTED`

Without durable identity evidence, a crash after the event but before or during service shutdown would leave a retry unable to distinguish the originally assessed writer containers from replacements started afterward.

With the intent, the later executor can fail closed if an expected running writer was replaced before its stop action, and can verify already-stopped containers by their durable container IDs after a crash.

## Next safe slice

The bounded writer-stop executor may now:

1. verify the signed writer-stop intent,
2. verify the execution chain is still `IMAGES_ACQUIRED` or already `WRITER_STOP_STARTED`,
3. before first stop, persist `WRITER_STOP_STARTED`,
4. stop only the exact intent-bound writer services/containers,
5. verify all exact writer containers are stopped,
6. verify libSQL remains running/available,
7. persist `WRITERS_STOPPED` only after those checks.

No migration belongs in that slice.
