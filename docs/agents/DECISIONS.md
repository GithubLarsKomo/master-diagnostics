# Decision Index

This file is a working index for agents. Binding decisions live in `ARCHITECTURE.md`, `SPEC.md` and `docs/adr/`. Where legacy provider wording in `SPEC.md` conflicts with ADR-0023, ADR-0023 and the updated `ARCHITECTURE.md` govern the persistence target until the provider-specific SPEC sections are reconciled during the PostgreSQL implementation track. Do not duplicate full ADR content here.

## Binding architectural decisions

- One fachlicher core supports SaaS and Club modes; provider differences stay behind adapters.
- Next.js App Router is the web/application shell.
- PostgreSQL 18.x is the canonical target persistence for Hosted/SaaS and autonomous Club deployments; baseline 18.6.
- The currently qualified libSQL/SQLite path is transitional and remains authoritative until all ADR-0023 migration gates pass; no dual write.
- Every product owns a separate PostgreSQL database and least-privilege role. Direct sibling-database SQL, shared application credentials and cross-application foreign keys are forbidden.
- Cross-product integration uses versioned APIs/events. Released diagnostics use `diagnostic.test.released` / `diagnostic-artifact-v1` as the first canonical boundary.
- Better Auth is mandatory for autonomous Club mode; SaaS identity remains behind the provider abstraction and may use platform SSO/Authentik.
- Every fachliche table is tenant-bound.
- Tenant context comes from authorized membership, not request payloads.
- Durable fachliche writes require authorization and transactional audit where specified.
- Offline synchronization uses globally unique operation IDs and optimistic versions.
- Version conflicts require explicit resolution; automatic overwrite is forbidden.
- Diagnostic algorithms live in the framework-independent `packages/diagnostics` package.
- Diagnostic runs persist algorithm name/version, exact inputs, exclusions, coefficients, warnings and a deterministic input hash.
- Released reports and interpretations are immutable and versioned.
- Master Diagnostics publishes diagnostic evidence but does not mutate training plans in Sport Athlete Management.

## Decisions requiring ADR consultation

Before changing any of the following, inspect `docs/adr/` and update or create an ADR:

- authentication or identity-provider boundaries,
- tenant and role model,
- database provider/schema conventions and migration strategy,
- PostgreSQL cutover or libSQL retirement,
- cross-product integration contracts,
- offline operation format or conflict semantics,
- diagnostic model definitions and interpolation/regression rules,
- report immutability and release workflow,
- external service requirements in Club mode,
- backup, restore and update architecture.

## Known open decision / implementation areas

- PostgreSQL provider/schema implementation and real PostgreSQL CI remain to be completed under the ADR-0023 migration gates.
- Existing libSQL backup/restore/privacy/offline evidence must be reproduced or exceeded before cutover.
- Provider-specific legacy wording in `SPEC.md` must be reconciled as part of that implementation without changing the diagnostic product scope.
- Exact modified-Dmax definition and supporting reference literature must remain governed by its dedicated ADR/evidence.
- Production deployment, backup/restore and update changes require explicit release evidence.
- Reporting, portability and deletion/anonymization workflows retain their existing privacy contracts during provider migration.

## Decision workflow

1. Identify whether a proposed change alters an invariant or only implements an existing decision.
2. Search `SPEC.md`, `ARCHITECTURE.md`, `TASKS.md` and `docs/adr/` for the existing rule.
3. If the rule is clear, reference it in the implementation and tests.
4. If provider wording conflicts, ADR-0023 controls the persistence target while existing libSQL runtime guarantees remain in force until cutover.
5. If another rule is missing or contradictory, create or amend an ADR before broad implementation.
6. Record consequences, rejected alternatives and migration impact.
7. Update this index only with a concise pointer or summary.

## Prohibited shortcuts

- Do not encode a major architecture decision only in code or a pull-request comment.
- Do not infer tenant identity from client-controlled IDs.
- Do not move diagnostic logic into UI, route handlers or database adapters.
- Do not make offline conflict resolution last-write-wins without a new approved decision.
- Do not change algorithm definitions merely to fit existing fixtures.
- Do not access another product database directly to avoid a versioned integration contract.
- Do not remove libSQL from the qualified runtime before PostgreSQL migration/reconciliation/restore evidence passes ADR-0023.
