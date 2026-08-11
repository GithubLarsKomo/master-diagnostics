# Masters Diagnostics

Trainerzentrierte PWA zur Planung, Durchführung und Auswertung wattbasierter Laktat-Stufentests auf BikeErg, RowErg und RP3.

> Status: **Club-Beta-Kandidat.** Der zentrale Trainerpfad ist implementiert und durch Unit-, Build- und Browser-E2E-Evidence abgesichert. Die erste Beta bleibt fail-closed, bis die in [`beta-readiness.md`](./beta-readiness.md) dokumentierten Release-Gates vollständig nachgewiesen sind. Die fachliche Grundlage steht in [`SPEC.md`](./SPEC.md).

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
# Club-Modus: anschließend http://localhost:3000/setup öffnen
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

## Stand des Club-Beta-Pfads

Für den lokalen Club-Modus sind die zentralen vertikalen Fähigkeiten umgesetzt und verifiziert:

1. Setup-Assistent und Single-Tenant-Bootstrap mit Better Auth,
2. Rollen- und Tenant-Isolation,
3. Athleten-, Einwilligungs- und Protokollverwaltung,
4. timergeführter Offline-Testworkflow mit Dexie-Persistenz, Wiederaufnahme und Sync-Retry,
5. Qualitätsprüfung, diagnostischer Fachkern, Trainingszonen, Dashboards und Vergleich,
6. deutsch- und englischsprachige Reports sowie Export-/Import-Roundtrip,
7. produktives Docker-/TLS-/Backup-/Restore-Grundgerüst mit fail-closed Betriebsverträgen,
8. automatisierter WCAG-Core-Browservertrag für stabile Club-Beta-Oberflächen.

Der verbindliche Beta-Status und die verbleibenden harten Release-Gates stehen in [`beta-readiness.md`](./beta-readiness.md). Die detaillierte Roadmap und spätere Produktziele stehen in [`TASKS.md`](./TASKS.md) und [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Lizenz

Noch festzulegen. Bis dahin ist das Repository nicht zur Weiterverteilung lizenziert.


## Epic 1 – Club-Bootstrap

Der Club-Modus enthält einen einmaligen Setup-Assistenten, Better Auth mit lokaler E-Mail-/Passwort-Anmeldung, die Anlage des Single-Tenants und des ersten Tenant-Admins sowie ein transaktionales Audit-Ereignis.
