# PostgreSQL Platform Convergence

**Status:** verbindlicher Migrationsplan  
**Target:** PostgreSQL 18.x, initial 18.6  
**Current qualified persistence:** libSQL/SQLite  
**ADR:** [ADR-0023](./adr/0023-postgresql-platform-convergence.md)

## 1. Ziel

Master Diagnostics soll dieselbe private PostgreSQL-18.x-Plattform wie die übrigen gehosteten Anwendungen nutzen, ohne seine fachliche Eigenständigkeit oder die bestehenden Offline-, Datenschutz-, Backup- und Restore-Garantien zu verlieren.

Zielzustand Hosted/SaaS:

```text
reverse proxy / SSO
        |
        v
Master Diagnostics
        |
        v
private PostgreSQL 18.x service
        |
        +-- database: master_diagnostics
        +-- runtime role: master_diagnostics_app
```

Zielzustand Club:

```text
Caddy -> Next.js -> local PostgreSQL 18.x
                -> persistent database volume
Backup job -> encrypted local/NAS target
```

Der lokale Club-Modus bleibt ohne Internet, externe Cloud-Datenbank, CDN, Telemetrie oder Lizenzserver funktionsfähig.

## 2. Kanonischer Verbindungsvertrag

```dotenv
DATABASE_URL=postgresql://master_diagnostics_app:<runtime_secret>@postgres:5432/master_diagnostics
DB_POOL_MAX=5
```

Regeln:

- `DATABASE_URL` ist geheim und wird nur zur Laufzeit injiziert.
- Port 5432 wird nicht öffentlich exponiert.
- Runtime-Role ist kein Superuser und besitzt keine Rechte auf Datenbanken anderer Anwendungen.
- Migrations-/Restore-Rechte werden getrennt von der Runtime-Role geführt.
- Bei Datenbankverkehr über Hostgrenzen ist TLS zusätzlich zum privaten Netz verpflichtend.

## 3. Kein Big-Bang-Providerwechsel

Der aktuell qualifizierte libSQL-Pfad bleibt bestehen, bis PostgreSQL äquivalente Evidenz besitzt. Es gibt keinen parallelen Dual-Write.

Phasen:

```text
A  Architecture lock
B  PostgreSQL provider + schema
C  PostgreSQL integration qualification
D  Operational control parity
E  Data migration + reconciliation
F  Controlled cutover
G  libSQL retirement
```

## 4. Phase A — Architecture lock

Abnahme:

- ADR-0023 accepted;
- PostgreSQL 18.x als Zielprovider dokumentiert;
- neue Persistenzentscheidungen dürfen die Migration nicht unnötig erschweren;
- Produktintegration erfolgt nicht über Datenbankzugriffe.

## 5. Phase B — Provider und Schema

Umsetzung:

- PostgreSQL-Driver hinter dem bestehenden DB-Modul;
- Drizzle-Schema für PostgreSQL;
- PostgreSQL-eigene Migrationen mit unveränderlichem Ledger und Checksumme;
- advisory transaction lock gegen parallele Migration Runner;
- `timestamptz` für Zeitpunkte, `date` für Kalendertage;
- `jsonb` für strukturierte Payloads, wo fachlich sinnvoll;
- Integer-Skalierung für Laktat/Gewicht und Watt-Semantik unverändert lassen.

Abnahme:

- Diagnostik-Golden-Master bleibt unverändert;
- keine Änderungen an Schwellen-/Zonenalgorithmen durch den Provider;
- Tenant-Isolation bleibt vollständig erhalten.

## 6. Phase C — Echte PostgreSQL-Integrationstests

CI muss PostgreSQL 18.x starten und mindestens prüfen:

- Fresh migration von leerer Datenbank;
- Migration ledger/checksums;
- CRUD für fachliche Kernentitäten;
- Transaktionsrollback;
- append-only Audit im selben Commit wie fachliche Mutation;
- Tenant-Isolation;
- Lock-/Lease-Semantik;
- `operation_id` idempotency;
- `expected_version` optimistic concurrency;
- Wiederholung einer Offline-Operation erzeugt keine Duplikate;
- Release/immutable report versions;
- Export-/Import-Roundtrip.

Mocks allein sind für den Cutover nicht ausreichend.

## 7. Phase D — Operational Control Parity

Vor Produktion müssen die vorhandenen libSQL-Betriebsverträge PostgreSQL-äquivalent nachgewiesen sein:

### Backup

- verschlüsselte Dumps/Backups;
- Checksumme;
- definierte Retention;
- Rollen/Ownership separat gesichert;
- kein ausschließlich containerlokales Backupziel.

### Restore

- Restore in isolierte Ziel-Datenbank;
- Manifest-/Checksum-Prüfung;
- Migration-/Schema-Prüfung;
- Privacy-Reconciliation;
- authentifizierter App-Smoke-Test nach Restore.

### Privacy

- fail-closed Capability-Preflight bleibt erhalten;
- Retention-Scan bleibt fachlich read-only;
- Widerruf, Löschung/Anonymisierung und Quarantäne verhalten sich unverändert;
- Support-/Tenant-/Betroffenenexporte behalten Verschlüsselungs- und Ablaufverträge.

### Offline

- IndexedDB bleibt lokale Testquelle während Ausfällen;
- Serverwechsel verändert keine Browserdatenstruktur ohne versionierten Migrationspfad;
- Konflikte werden niemals still überschrieben.

## 8. Phase E — libSQL → PostgreSQL Migration

Ein reproduzierbares Migrationstool muss:

1. libSQL-Source nur nach geprüftem Backup öffnen;
2. fachliche Tabellen in definierter Reihenfolge exportieren;
3. technische und fachliche IDs erhalten, soweit der Vertrag dies verlangt;
4. Datentypen explizit transformieren;
5. PostgreSQL in einer kontrollierten Transaktions-/Batchstrategie befüllen;
6. Counts, Schlüssel, Hashes und fachliche Invarianten vergleichen;
7. freigegebene Berichte und diagnostische Result-Hashes verifizieren;
8. einen maschinenlesbaren Reconciliation-Report erzeugen.

Mindestens ein repräsentativer produktionsnaher Datenbestand muss vollständig migriert und reconciled werden.

## 9. Phase F — Controlled Cutover

Produktions-Cutover:

1. Wartungsfenster / Schreibstopp aktivieren.
2. Finales libSQL-Backup inklusive Prüfsumme erzeugen.
3. PostgreSQL-Ziel leer und migrationsaktuell bereitstellen.
4. Daten migrieren.
5. Reconciliation muss ohne ungeklärte Differenzen bestehen.
6. `DATABASE_URL` auf PostgreSQL umschalten.
7. Readiness + authentifizierte End-to-End-Smoke-Tests durchführen.
8. Erstes PostgreSQL-Backup erzeugen.
9. Dieses Backup in isolierter Umgebung restaurieren und prüfen.
10. Schreibbetrieb erst danach freigeben.

Rollback bleibt bis zur Freigabe des PostgreSQL-Betriebs der unveränderte libSQL-Sourcebestand; es gibt keine Rücksynchronisation aus einem bereits beschriebenen PostgreSQL-System.

## 10. Phase G — libSQL Retirement

Erst nach dokumentierter Cutover-Abnahme:

- libSQL aus regulären Hosted-/Club-Compose-Pfaden entfernen;
- libSQL Runtime-Abhängigkeiten aus dem App-Pfad entfernen;
- Migrations-/Importwerkzeuge bei Bedarf als offline Legacy-Tool erhalten;
- Backup-/Restore-Dokumentation endgültig auf PostgreSQL umstellen;
- CI darf keine libSQL-Produktionsannahmen mehr als kanonischen Zielzustand behandeln.

## 11. Plattformisolation

Die gemeinsame PostgreSQL-Instanz darf mehrere Produktdatenbanken hosten, aber:

```text
master_diagnostics_app -> master_diagnostics only
sport_athlete_app      -> sport_athlete only
other_app              -> own database only
```

Cross-App-Datenfluss erfolgt über versionierte Verträge. Für freigegebene Diagnostik siehe [Diagnostic Artifact Integration](./diagnostic-artifact-integration.md).

## 12. Definition of Done

Die PostgreSQL-Konvergenz ist abgeschlossen, wenn:

- Hosted und Club PostgreSQL 18.x verwenden;
- jede Installation unabhängige Backup-/Restore-Evidenz besitzt;
- real PostgreSQL integration tests grün sind;
- Offline-/Sync-Regressionen grün sind;
- libSQL-Datenmigration und Reconciliation reproduzierbar sind;
- ein echter Cutover inklusive Restore-Drill bestanden wurde;
- libSQL nicht mehr im produktiven Runtime-Pfad benötigt wird;
- keine andere Produktdatenbank direkt gelesen oder geschrieben wird.
