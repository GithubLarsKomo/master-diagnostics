# Decision Index

This file is a working index for agents. Binding decisions live in `ARCHITECTURE.md`, `SPEC.md` and `docs/adr/`. Do not duplicate full ADR content here.

## Binding architectural decisions

- One fachlicher core supports SaaS and Club modes; provider differences stay behind adapters.
- Next.js App Router is the web/application shell.
- Drizzle ORM targets SQLite-compatible libSQL/Turso storage.
- Better Auth is mandatory for autonomous Club mode; Clerk is the preferred SaaS provider.
- Every fachliche table is tenant-bound.
- Tenant context comes from authorized membership, not request payloads.
- Durable fachliche writes require authorization and transactional audit where specified.
- Offline synchronization uses globally unique operation IDs and optimistic versions.
- Version conflicts require explicit resolution; automatic overwrite is forbidden.
- Diagnostic algorithms live in the framework-independent `packages/diagnostics` package.
- Diagnostic runs persist algorithm name/version, exact inputs, exclusions, coefficients, warnings and a deterministic input hash.
- Released reports and interpretations are immutable and versioned.

## Decisions requiring ADR consultation

Before changing any of the following, inspect `docs/adr/` and update or create an ADR:

- authentication or identity-provider boundaries,
- tenant and role model,
- database schema conventions and migration strategy,
- offline operation format or conflict semantics,
- diagnostic model definitions and interpolation/regression rules,
- report immutability and release workflow,
- external service requirements in Club mode,
- backup, restore and update architecture.

## Known open decision areas

- Exact modified-Dmax definition and supporting reference literature must be closed before implementation.
- Final SaaS Clerk adapter behavior remains pending.
- Production Docker, backup/restore and update design still have open release work.
- Reporting, portability and deletion/anonymization workflows require later decisions and validation.

## Decision workflow

1. Identify whether a proposed change alters an invariant or only implements an existing decision.
2. Search `SPEC.md`, `ARCHITECTURE.md`, `TASKS.md` and `docs/adr/` for the existing rule.
3. If the rule is clear, reference it in the implementation and tests.
4. If the rule is missing or contradictory, create or amend an ADR before broad implementation.
5. Record consequences, rejected alternatives and migration impact.
6. Update this index only with a concise pointer or summary.

## Prohibited shortcuts

- Do not encode a major architecture decision only in code or a pull-request comment.
- Do not infer tenant identity from client-controlled IDs.
- Do not move diagnostic logic into UI, route handlers or database adapters.
- Do not make offline conflict resolution last-write-wins without a new approved decision.
- Do not change algorithm definitions merely to fit existing fixtures.
