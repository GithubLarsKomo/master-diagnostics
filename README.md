# Masters Diagnostics

Trainerzentrierte PWA zur Planung, Durchführung und Auswertung wattbasierter Laktat-Stufentests auf BikeErg, RowErg und RP3.

> Status: Repository-Grundgerüst. Die fachliche Grundlage steht in [`SPEC.md`](./SPEC.md).

## Zielbild

- **SaaS-Modus:** Multi-Tenant, Clerk, Turso Cloud
- **Club-Modus:** genau ein Tenant, Better Auth, lokaler libSQL-Server, vollständig autark
- **Frontend/Backend:** Next.js App Router, React, TypeScript
- **Datenzugriff:** Drizzle ORM, serverseitig autorisiert
- **Offline:** PWA + IndexedDB/Dexie für laufende Tests
- **Diagnostik:** eigenständiger, versionierter Fachkern

## Repository-Struktur

```text
apps/web                 Next.js-PWA und serverseitige Anwendungslogik
packages/domain          Fachtypen, Zustandsmodelle und Autorisierungsregeln
packages/diagnostics     Schwellen- und Zonenalgorithmen
packages/db              Drizzle-Schema, Migrationen und Datenbankprovider
packages/auth            Clerk-/Better-Auth-Abstraktion
packages/sync            Offline-/Online-Synchronisationsprotokoll
packages/config          Gemeinsame TypeScript-/Lint-Konfiguration
docs                     Architektur, ADRs, Betrieb und Fachkonzepte
infra                    Docker, Reverse Proxy, Backup und Updates
tests                    Referenzdaten und systemübergreifende Tests
```

## Schnellstart – Entwicklung

Voraussetzungen: Node.js 22+, pnpm 10+, Docker Compose.

```bash
cp .env.example .env
pnpm install
docker compose -f infra/docker-compose.dev.yml up -d
pnpm db:push
pnpm dev
```

Danach: `http://localhost:3000`.

## Qualitätsbefehle

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

## Erste Implementierungsziele

1. lokalen Setup-Assistenten und Single-Tenant-Bootstrap implementieren
2. Rollen- und Tenant-Isolation absichern
3. Athleten- und Protokollverwaltung ergänzen
4. timergeführten Offline-Testworkflow implementieren
5. diagnostischen Fachkern anhand der Referenzdatensätze validieren

Details: [`TASKS.md`](./TASKS.md) und [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Lizenz

Noch festzulegen. Bis dahin ist das Repository nicht zur Weiterverteilung lizenziert.
