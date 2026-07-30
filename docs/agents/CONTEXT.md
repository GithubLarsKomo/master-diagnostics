# Shared Domain Context

## Product purpose

Masters Diagnostics is a trainer-centered PWA for planning, conducting and evaluating watt-based lactate step tests on BikeErg, RowErg and RP3. It supports two operating modes with one shared fachlicher Kern:

- SaaS: multiple isolated tenants, Clerk and Turso Cloud.
- Club: exactly one tenant, Better Auth and a local libSQL server without mandatory external services.

## Primary actors

- Athlete: subject of tests, consents, reports and longitudinal comparison.
- Coach: plans and conducts tests, reviews data and makes diagnostic decisions.
- Tenant admin: manages local organization, users and configuration.
- Guardian: supplies required consent for minors where applicable.

## Core terminology

- Tenant: isolated organization boundary. Every fachliche record belongs to a tenant.
- Membership: authorized relation between identity, tenant and role; source of tenant context.
- Athlete snapshot: immutable copy of relevant athlete data attached to a test context.
- Protocol template/version: versioned definition used to create an immutable test-plan snapshot.
- Test-plan snapshot: frozen plan used during execution; later template changes must not alter it.
- Stage: one workload interval in the lactate step test.
- Partial stage: stage counted according to the specified minimum-completion rule.
- Measurement qualifier: exact value or bounded value such as less-than/greater-than.
- Data review: explicit state after execution where measurements and quality decisions are finalized.
- Diagnostic run: reproducible model execution with versioned algorithm, inputs, exclusions, coefficients, warnings and input hash.
- Trainer decision: documented expert selection or adjustment of diagnostic results.
- Release/report version: immutable approved interpretation for export and comparison.
- Operation ID: globally unique identifier used to make offline synchronization idempotent.
- Expected version: optimistic concurrency value used to detect conflicts.

## Non-negotiable invariants

1. Tenant isolation applies to every fachliche read and write.
2. Tenant context is derived server-side from the authorized membership.
3. Club mode contains exactly one tenant and allows bootstrap only once.
4. Fachliche writes follow authorization, transaction and audit requirements.
5. Approved reports, interpretations and relevant snapshots are immutable and versioned.
6. Offline operations execute at most once and conflicts are never overwritten silently.
7. `packages/diagnostics` remains independent of React, Next.js and database code.
8. Diagnostic calculations are deterministic and retain algorithm/version/input evidence.
9. The application must remain useful in Club mode without CDN, telemetry or mandatory external mail.
10. Safety, consent and readiness gates must not be bypassed by UI-only checks.

## Current implementation focus

Epics 0–3 are substantially complete. Epic 4 has implemented major foundations for state transitions, timer persistence, measurement drafts, restart recovery and idempotent synchronization, but still contains incomplete execution and warning behavior. Epic 5 still needs automatic plausibility warnings and full qualifier handling. Epic 6, the diagnostic core, is the next major fachliche workstream.

## Language and documentation

- Code identifiers and skill names: English.
- Product and architecture documentation: currently primarily German.
- Preserve precise domain terms and define new ones here or in the relevant ADR before using competing synonyms.
