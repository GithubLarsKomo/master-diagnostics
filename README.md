# Masters Diagnostics

Trainerzentrierte PWA zur Planung, Durchführung und Auswertung wattbasierter Laktat-Stufentests auf BikeErg, RowErg und RP3.

> Status: **Club-Beta-Kandidat.** Der zentrale Trainerpfad ist implementiert und durch Unit-, Build- und Browser-E2E-Evidence abgesichert. Die erste Beta bleibt fail-closed, bis die in [`beta-readiness.md`](./beta-readiness.md) dokumentierten Release-Gates vollständig nachgewiesen sind. Die fachliche Grundlage steht in [`SPEC.md`](./SPEC.md).
>
> **Persistenz-Ziel:** PostgreSQL 18.x ist gemäß [ADR-0023](./docs/adr/0023-postgresql-platform-convergence.md) die verbindliche Zielplattform für Hosted/SaaS und den autarken Club-Modus. Der bestehende libSQL-Pfad bleibt als qualifizierter Übergangsprovider aktiv, bis Offline-, Backup-/Restore-, Privacy-, Migration- und Reconciliation-Gates unter PostgreSQL bestanden sind.

## Zielbild

- **SaaS-/Hosted-Modus:** Multi-Tenant, konfigurierter Identity-/SSO-Provider, private PostgreSQL-18.x-Datenbank `master_diagnostics`
- **Club-Modus:** genau ein Tenant, Better Auth, langfristig lokaler PostgreSQL-18.x-Container, vollständig autark; libSQL bis zum qualifizierten Cutover
- **Frontend/Backend:** Next.js App Router, React, TypeScript
- **Datenzugriff:** Drizzle ORM, serverseitig autorisiert
- **Offline:** PWA + IndexedDB/Dexie für laufende Tests
- **Diagnostik:** eigenständiger, versionierter Fachkern
- **Produktintegration:** ausschließlich versionierte APIs/Events; keine direkten Cross-Database-Zugriffe

## Plattformgrenzen

Master Diagnostics besitzt seine diagnostischen Daten und seine Datenbank selbst. Eine gemeinsam betriebene PostgreSQL-Instanz bedeutet keine gemeinsame Anwendungsdatenbank: andere Produkte erhalten eigene Datenbanken und Runtime-Rollen. Freigegebene Diagnostik kann über [`diagnostic-artifact-v1`](./docs/diagnostic-artifact-integration.md) und `diagnostic.test.released` an Sport Athlete Management/Skillz übergeben werden; Master Diagnostics verändert niemals direkt Trainingspläne.

## Repository-Struktur

```text
apps/web                 Next.js-PWA und serverseitige Anwendungslogik
packages/domain          Fachtypen, Zustandsmodelle und Autorisierungsregeln
packages/diagnostics     Schwellen- und Zonenalgorithmen
packages/db              Drizzle-Schema, Migrationen und Datenbankprovider
packages/auth            Identity-Provider-Abstraktion
packages/sync            Offline-/Online-Synchronisationsprotokoll
packages/config          Gemeinsame TypeScript-/Lint-Konfiguration
docs                     Architektur, ADRs, Betrieb und Fachkonzepte
infra                    Docker, Reverse Proxy, Backup und Updates
tests                    Referenzdaten und systemübergreifende Tests
```

## Schnellstart – Entwicklung

Voraussetzungen: Node.js 22+, pnpm 10+, Docker Compose.

Der derzeitige Entwicklungs-/Beta-Pfad nutzt noch den qualifizierten libSQL-Stack. Die Umstellung des Runtime-Pfads auf PostgreSQL erfolgt erst nach den Gates in [`docs/postgresql-convergence.md`](./docs/postgresql-convergence.md).

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

Der verbindliche Beta-Status und die verbleibenden harten Release-Gates stehen in [`beta-readiness.md`](./beta-readiness.md). Die detaillierte Roadmap und spätere Produktziele stehen in [`TASKS.md`](./TASKS.md) und [`ARCHITECTURE.md`](./ARCHITECTURE.md). Die PostgreSQL-Konvergenz ist ein eigener kontrollierter Infrastrukturpfad und kein Vorwand, bestehende Beta-Sicherheitsverträge zu umgehen.

## Lizenz

Noch festzulegen. Bis dahin ist das Repository nicht zur Weiterverteilung lizenziert.

## Epic 1 – Club-Bootstrap

Der Club-Modus enthält einen einmaligen Setup-Assistenten, Better Auth mit lokaler E-Mail-/Passwort-Anmeldung, die Anlage des Single-Tenants und des ersten Tenant-Admins sowie ein transaktionales Audit-Ereignis.