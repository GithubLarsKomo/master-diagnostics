# Diagnostic Artifact Integration

**Status:** architecture contract v1  
**Producer:** Master Diagnostics  
**Initial consumer:** Sport Athlete Management / Skillz  
**Transport:** versioned API/event integration; never direct cross-database SQL

## 1. Purpose

Master Diagnostics owns diagnostic measurement, quality review, threshold calculations, trainer interpretation and release. Other products may consume released diagnostic evidence, but they do not own or mutate the diagnostic source record.

The integration boundary is:

- event type: `diagnostic.test.released`
- payload contract: `diagnostic-artifact-v1`

Only a released, immutable diagnostic state may be published.

## 2. Domain boundary

Master Diagnostics may publish evidence that can inform training decisions. It must not:

- write into the Sport Athlete Management database;
- directly alter training plans;
- bypass the Sport adaptation engine;
- expose draft/unreviewed thresholds as authoritative released results;
- use names, email addresses or birth dates as cross-product identity keys.

The consuming product remains responsible for its own authorization, athlete mapping, training decisions, versioning and audit.

## 3. Identity

Each product keeps its own local athlete record. Cross-product association uses a stable external subject/athlete reference that is explicitly mapped inside each product.

Required properties:

- opaque and stable;
- not derived from personal data;
- tenant-scoped or otherwise collision-safe;
- mapping changes auditable;
- no implicit matching by name/date of birth/email.

## 4. Artifact envelope

Conceptual v1 shape:

```json
{
  "schema_version": 1,
  "artifact_id": "01...",
  "event_id": "01...",
  "event_type": "diagnostic.test.released",
  "external_athlete_ref": "opaque-stable-ref",
  "tenant_ref": "opaque-tenant-ref",
  "diagnostic_type": "lactate_step_test",
  "performed_at": "2026-08-24T08:00:00Z",
  "released_at": "2026-08-24T10:00:00Z",
  "modality": "ROWERG",
  "protocol": {},
  "thresholds": {},
  "heart_rate": {},
  "zones": {},
  "quality": {},
  "interpretation": {},
  "source": {
    "system": "master-diagnostics",
    "test_id": "...",
    "test_version": 1,
    "report_version": 1
  }
}
```

The implementation schema must be versioned and validated at producer and consumer boundaries before production use.

## 5. Required semantic content

### Envelope

- `schema_version`
- globally unique `artifact_id`
- globally unique `event_id`
- exact `event_type`
- stable external athlete reference
- tenant/privacy scope
- diagnostic type
- performed/released timestamps

### Protocol summary

Enough information to assess comparability without duplicating the entire source test:

- device/modality;
- protocol/template version;
- stage duration;
- increment or relevant stage schedule;
- relevant deviations affecting interpretation.

### Thresholds and zones

Only released trainer-authoritative values plus necessary model context. Automated model outputs may be included as supporting evidence but must remain distinguishable from the final trainer decision.

### Quality

- overall release/quality status;
- unresolved or accepted limitations;
- excluded/partial-data context needed for downstream interpretation;
- uncertainty or comparability caveats where applicable.

### Provenance

- source system;
- source test identifier;
- immutable source/test version;
- report/interpretation version;
- release timestamp;
- algorithm versions/hashes where required to reproduce the released interpretation.

## 6. Versioning and immutability

A published artifact is immutable. If a released test receives a new interpretation/report version, the producer emits a new artifact/event rather than overwriting the old payload.

Consumers retain source provenance and may mark prior artifacts superseded, but do not erase history merely because a newer artifact exists.

## 7. Idempotency

Consumers use `event_id`/`artifact_id` to guarantee at-most-once logical ingestion. Re-delivery of the same event must not create a duplicate diagnostic artifact.

Transport acknowledgement is separate from domain processing. A transient consumer failure may cause retry; the idempotency contract makes retries safe.

## 8. Privacy and data minimization

The artifact includes only fields necessary for the consuming purpose. Full diagnostic raw data, health notes, medication details, free text and direct identifiers are excluded unless a separately versioned contract and legal basis explicitly require them.

Publication must respect:

- tenant boundaries;
- consent/use restrictions;
- withdrawal/use blocks;
- data-subject deletion/anonymization rules;
- recipient authorization.

## 9. Failure behavior

Fail closed:

- draft/non-released test -> no artifact;
- invalid schema -> no publication;
- missing stable athlete mapping -> no implicit personal-data matching and no publication to the target consumer;
- consumer unavailable -> source release remains valid locally; event stays retryable according to outbox policy;
- duplicate delivery -> no duplicate domain artifact.

A failed downstream integration must never roll back a clinically/sport-scientifically valid local release unless the release transaction itself failed.

## 10. Outbox recommendation

When implemented, publication should use a transactional outbox in the Master Diagnostics database so release state and the pending integration event cannot diverge.

Conceptual fields:

```text
event_id
event_type
aggregate_type
aggregate_id
aggregate_version
tenant_id
occurred_at
schema_version
payload_json
publish_status
attempt_count
last_attempt_at
```

The outbox is repository-owned. It does not provide access to another product's database.

## 11. Sport Athlete Management consumption

Recommended flow:

```text
Master Diagnostics release
  -> diagnostic.test.released
  -> diagnostic-artifact-v1
  -> Sport API/event ingest
  -> stored versioned diagnostic evidence
  -> Skillz performance/testing/adaptation reasoning
  -> adaptation proposal
  -> explicit/app-controlled plan revision
```

Diagnostic evidence can trigger or inform retesting, performance-model updates and adaptation analysis, but Master Diagnostics never performs the training-plan mutation itself.

## 12. Future events

Potential later contracts, only when there is a demonstrated consumer need:

- `diagnostic.test.planned`
- `diagnostic.test.started`
- `diagnostic.test.superseded`

They are not required for v1. `diagnostic.test.released` is intentionally the first authoritative cross-product boundary.
