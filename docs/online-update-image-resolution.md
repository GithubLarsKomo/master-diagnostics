# Online Update Image Resolution v1

## Purpose

This gate verifies that the two immutable image references already bound into signed update preparation evidence actually exist in their registry and resolve to the exact expected manifest digests.

It does not pull image layers and does not mutate the Club deployment.

## Input trust chain

The resolver consumes the HMAC-verified `online-update-preparation.json`. That preparation already binds:

- signed update selection,
- manifest and target version,
- exact APP and MIGRATOR digest references,
- release-note bytes,
- a fresh verified pre-update backup.

The image-resolution stage does not accept replacement image references on its command line.

## Registry verification

For each role (`APP`, `MIGRATOR`) the resolver executes:

```text
docker manifest inspect --verbose <immutable-reference>
```

The returned registry descriptor must contain a valid `sha256:` digest exactly equal to the digest in the signed reference.

Evidence records only technical descriptor metadata:

- role,
- immutable reference,
- manifest digest,
- media type,
- descriptor size,
- `available=true`.

No image layer is pulled.

## Insecure registry exception

`--allow-insecure-localhost` exists only to support isolated local contract registries. It is rejected unless the registry host is exactly `localhost` or `127.0.0.1`.

Production registry resolution remains TLS-protected and does not use this switch.

## Signed evidence

The canonical file is:

```text
online-update-image-resolution.json
```

Signing domain:

```text
masters:club-online-update-image-resolution:v1
```

The record binds:

- preparation signature,
- manifest fingerprint,
- target version,
- both exact role/reference/descriptor identities,
- `allImmutableReferencesAvailable=true`,
- `descriptorDigestsMatch=true`.

Safety flags remain:

```text
imagePullAllowed=false
migrationAllowed=false
productionMutationAllowed=false
updateExecuted=false
```

Evidence is persisted in a `0700` directory and exclusive-created as `0600`. Identical retries reuse the existing signed record; changed registry evidence conflicts rather than overwriting prior evidence.

## Contract

The server contract starts an isolated local Docker Registry v2 instance, builds and pushes two distinct scratch-image manifests, and constructs the full authentic chain through selection, real encrypted backup verification, and preparation.

It then verifies the exact digest references through registry manifest inspection and checks:

- both immutable references exist,
- descriptor digests equal the signed references,
- signed evidence is retry-stable,
- a nonexistent digest fails,
- HMAC tampering fails,
- insecure inspection is refused for non-local registries,
- the resolver contains no image-pull or Club Compose mutation path.

## Next gate

The next stage may create a signed online-update execution plan that binds the resolved image identities, fresh pre-update backup, migration order, health checks, and rollback policy. Actual image pull/migration/service mutation must remain behind that separate plan and execution journal.
