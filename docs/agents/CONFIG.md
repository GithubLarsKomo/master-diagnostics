# Agent Configuration

## Repository

- Repository: `GithubLarsKomo/master-diagnostics`
- Default branch: `main`
- Package manager: `pnpm@10.15.0`
- Runtime baseline: Node.js 22+
- Architecture: TypeScript monorepo with Next.js App Router, Drizzle ORM, libSQL/Turso, PWA and IndexedDB/Dexie

## Primary sources of truth

Read these before substantial changes:

1. `SPEC.md` for approved product requirements.
2. `ARCHITECTURE.md` for system boundaries and invariants.
3. `TASKS.md` for current implementation status and release gates.
4. `docs/adr/` for binding architecture decisions.
5. Package-local tests and README files for executable behavior.

When documents disagree, do not silently choose one. Identify the conflict and resolve it through the smallest explicit documentation change or a new ADR.

## Standard quality commands

Run the smallest relevant checks during development and all applicable checks before declaring a change complete:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Database tasks:

```bash
pnpm db:generate
pnpm db:push
pnpm db:migrate
```

For local HTTP checks in environments with a default proxy, bypass the proxy explicitly, for example:

```bash
NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 curl --noproxy "*" http://127.0.0.1:3000
```

## Change strategy

- Work in small vertical slices that leave the repository buildable.
- Prefer extending an existing module over adding parallel abstractions.
- Keep domain and diagnostics packages framework-independent.
- Derive tenant context from an authorized membership, never from client input.
- Couple every durable mutation with authorization and audit behavior where required.
- Preserve offline idempotency, optimistic versions and explicit conflict handling.
- Add or update tests with every behavior change.
- Do not weaken a release gate merely to make CI pass.

## Allowed write areas

Changes may normally touch:

- `apps/`
- `packages/`
- `tests/`
- `docs/`
- `infra/`
- root configuration and documentation files

Treat generated migrations, lockfiles, workflow files and deployment configuration as high-impact. Inspect their full diff before publication.

## Pull requests

A pull request should state:

- the user-visible or architectural outcome,
- the affected invariant or task,
- tests and commands executed,
- migrations or operational consequences,
- remaining risks and follow-up work.

Do not merge while required checks fail, review threads remain actionable, or the implementation contradicts an open release gate.
