# PRODUCT.md — Masters Diagnostics

## Product statement

Masters Diagnostics is an operator-first diagnostic application for planning, conducting, reviewing and releasing structured performance tests. The product serves athletes, trainers and tenant administrators while preserving tenant isolation, auditability, versioned diagnostic reasoning and reliable offline/test-floor workflows.

This file is the authoritative product-context entry point for frontend decisions. Detailed domain behavior remains in `SPEC.md`, `ARCHITECTURE.md` and the domain packages.

## Primary users

### Trainer

Needs a fast task-oriented view of athletes and tests, with minimal navigation during preparation, live testing and review.

### Athlete

Needs clear identity, consent, test preparation, current test status and released results without operational clutter.

### Tenant administrator

Needs safe user/role administration, data lifecycle controls, exports and auditable operations.

## Core jobs

1. Find the next meaningful action without scanning the whole system.
2. Create and maintain athlete context safely.
3. Plan a test from an explicit protocol/version.
4. Conduct a live test with large, unambiguous time and measurement affordances.
5. Review measurements and warnings before diagnostic calculation/release.
6. Preserve versioned diagnostic inputs, outputs and human decisions.
7. Export, retain, delete and restore data with traceable evidence.

## Product principles

- **Task first:** the next operator action is more important than decorative overview metrics.
- **Clinical/diagnostic calm:** serious, legible and restrained; no gamification.
- **Data provenance is visible:** versions, status and warnings must be understandable at the point of use.
- **Safety beats speed:** irreversible and privacy-relevant actions need explicit framing and confirmation.
- **Tablet viable:** live-test and review flows must remain usable on a tablet without hiding critical information.
- **Offline-aware:** transient connectivity must not turn a running test into an ambiguous state.
- **No AI theatre:** algorithmic outputs are presented with method/version/context rather than as opaque intelligence.

## Surface hierarchy

1. Dashboard / next tasks
2. Athletes
3. Test planning and preparation
4. Live test
5. Measurement review
6. Diagnostic result/release
7. Administration, export, privacy and restore

## Shared platform boundary

Hosted deployments converge on the shared private MariaDB 11.8 infrastructure defined in `docs/shared-db-infrastructure.md`. Masters Diagnostics owns its own database/schema and never couples directly to the Sport app's tables.

## Frontend authority

`DESIGN.md` defines the visual and interaction system. Existing implementation should be evolved toward it rather than rewritten solely for aesthetic reasons.
