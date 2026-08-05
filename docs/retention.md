# Retention und Löschphasen

## Ziel

Die Retention-Logik trennt bewusst drei unterschiedliche Vorgänge:

1. **Sofortige Nutzungssperre** nach Widerruf oder Löschantrag.
2. **Soft-Delete** des Athletenprofils, damit es im normalen Betrieb nicht weiterverwendet wird.
3. **Irreversible Pseudonymisierung/Entfernung** erst nach Ablauf der maßgeblichen Aufbewahrungsfrist und einer expliziten Freigabe.

Der in Epic 10 eingeführte Retention-Assessment-Service ist ausschließlich read-only und entscheidet nur über Punkt 3. Er löscht, anonymisiert oder verändert keine Daten.

## Regeln aus SPEC §32

### Athleten mit tatsächlich begonnenem Test

Für einen Athleten mit mindestens einem begonnenen Test gilt die tenant-spezifische Aufbewahrungsfrist von **1 bis 10 Jahren** ab dem letzten Test.

Als Testreferenz wird verwendet:

1. `endedAt`, wenn vorhanden,
2. sonst `startedAt`,
3. nur für nicht-`PLANNED`-Legacy-Datensätze ohne beide Zeitpunkte `createdAt`.

Ein nur geplanter und nie gestarteter Test verlängert die Frist nicht.

### Verwaltetes Profil ohne Test

Ein Profil ohne Login-Verknüpfung (`linkedUserId = NULL`) und ohne tatsächlich begonnenen Test wird **12 Monate ab Profilanlage** aufbewahrt.

### Verknüpftes Profil ohne Test

Für ein mit einem Benutzerkonto verknüpftes Profil ohne Test definiert SPEC §32 keine automatische Frist. Der Assessment-Service arbeitet deshalb fail-closed:

- Basis: `MANUAL_REVIEW`
- keine automatisch berechnete Löschfreigabe
- irreversible Aktion bleibt gesperrt.

## Kalenderarithmetik

Fristen werden kalenderbasiert berechnet. Nicht existente Jahrestage werden auf den letzten gültigen Kalendertag geklemmt, z. B.:

- Referenz: 29.02.2024
- +1 Jahr: 28.02.2025

## Ergebnisvertrag

Die Bewertung liefert:

- `basis`: `LAST_TEST`, `MANAGED_PROFILE_NO_TEST` oder `MANUAL_REVIEW`
- `reason`: `RETENTION_ACTIVE`, `RETENTION_EXPIRED` oder `MANUAL_REVIEW_REQUIRED`
- konfigurierte Tenant-Frist
- Referenzzeitpunkt
- `retainUntil`
- `eligibleForIrreversibleAction`

`eligibleForIrreversibleAction = true` ist nur eine notwendige Vorbedingung. Ein späterer Pseudonymisierungs-/Löschservice muss zusätzlich einen freigegebenen Löschworkflow und weitere Schutzbedingungen prüfen.

## Tenantweite Retention-Worklist

`listTenantRetentionCandidates()` baut eine deterministische, tenantgebundene und vollständig read-only Worklist:

- Athleten mit noch aktiver Aufbewahrungsfrist werden nicht aufgenommen.
- Abgelaufene Assessments erhalten `disposition = ELIGIBLE`.
- Fail-closed-Fälle erhalten `disposition = MANUAL_REVIEW` und bleiben für automatisierte irreversible Verarbeitung gesperrt.
- Die Ausgabe ist nach `athleteId` stabil sortiert und enthält zusätzlich `consentBlockedAt` und `deletedAt`, damit nachgelagerte Schutzprüfungen ihren Zustand bewerten können.
- Die Worklist selbst prüft **keine** Freigabe eines Löschantrags und führt keine Datenänderung aus.

Damit bedeutet `ELIGIBLE` weiterhin ausschließlich: Die Retention-Frist steht einer späteren irreversiblen Aktion nicht mehr entgegen. Es ist keine Löschfreigabe.

## Read-only Retention-Job

`buildRetentionJobPlan()` führt die Worklist tenantweise zu einem deterministischen Job-Plan zusammen. Der Plan enthält:

- den Modus `READ_ONLY`,
- einen gemeinsamen Bewertungszeitpunkt,
- stabile Tenant-Reihenfolge,
- Kandidaten-, `ELIGIBLE`- und `MANUAL_REVIEW`-Zähler,
- die unveränderte Kandidatenliste je Tenant.

Der Runner verändert weder Athleten- noch Test- oder Löschdaten. Ein unbekannter gezielt angeforderter Tenant beendet den Lauf fail-closed mit Fehler.

Der ausführbare Einstiegspunkt ist:

```bash
pnpm retention:scan
```

Er verwendet `DATABASE_URL` und optional `DATABASE_AUTH_TOKEN` wie die übrigen DB-Werkzeuge. Für gezielte oder reproduzierbare Läufe können gesetzt werden:

```bash
RETENTION_JOB_TENANT_ID=<tenant-id> pnpm retention:scan
RETENTION_JOB_ASSESSED_AT=2027-07-31T00:00:00.000Z pnpm retention:scan
```

Standardmäßig wird der vollständige Plan als JSON auf `stdout` ausgegeben. Für dauerhaft protokollierte Scheduler-Läufe steht ein minimierter Modus zur Verfügung:

```bash
RETENTION_JOB_OUTPUT=summary pnpm retention:scan
```

Die Summary enthält ausschließlich `mode`, `assessedAt`, `tenantCount`, `candidateCount`, `eligibleCount` und `manualReviewCount`. Sie enthält keine Tenant-, Athleten- oder verknüpften User-IDs.

Ein unbekannter `RETENTION_JOB_OUTPUT`-Wert wird nicht stillschweigend interpretiert, sondern beendet den Runner mit Fehler.

## Produktive Zeitplanung im Club-Modus

`infra/docker-compose.club.yml` enthält einen separaten `retention-scan`-Service. Er:

- startet erst nach erfolgreicher Datenbankmigration,
- verwendet dieselbe libSQL-Datenbank wie die App,
- setzt `RETENTION_JOB_OUTPUT=summary`,
- führt unmittelbar beim Containerstart einen Scan aus,
- wartet nach einem erfolgreichen Lauf 86.400 Sekunden,
- wiederholt danach den read-only Scan,
- beendet sich bei einem Jobfehler über `set -e`, sodass `restart: unless-stopped` einen sichtbaren Retry auslöst.

Die Kadenz ist damit täglich, aber relativ zum letzten erfolgreichen Start/Lauf; sie ist bewusst kein kalendergenauer Mitternachts-Cron. Andere Deployment-Modi müssen einen äquivalenten periodischen Aufruf bereitstellen.

Wichtig: Auch ein im Job als `ELIGIBLE` geführter Datensatz wird **nicht** verändert. Der Scheduler erzeugt keine Anonymisierungs-Approval, startet keinen Writer und führt keine automatische Löschung aus.

## Read-only Schutzprüfung vor irreversibler Verarbeitung

`getAthleteIrreversibleProcessingPrecheck()` kombiniert die Retention-Bewertung mit dem tatsächlichen Löschworkflow und arbeitet weiterhin vollständig read-only.

Der Precheck ist nur bestanden, wenn zum gemeinsamen Bewertungszeitpunkt:

- die Retention-Frist abgelaufen ist,
- keine manuelle Retention-Prüfung offen ist,
- die Nutzungssperre bereits wirksam ist,
- der Soft-Delete bereits wirksam ist,
- und ein `COMPLETED`-Löschantrag mit wirksamem `completedAt` existiert.

Spätere Ereignisse dürfen einen historischen Assessment-Zeitpunkt nicht rückwirkend freigeben. Die Prüfung liefert deshalb strukturierte Blocker und berücksichtigt nur Zustände, die spätestens zu `assessedAt` wirksam waren.

`passesPrecheck = true` ist erneut nur eine notwendige Vorbedingung. Die irreversible Ausführung bleibt zusätzlich an versionierte Policy, globale Privacy-Capabilities und explizite Tenant-Admin-Freigabe gebunden.

## UI-Vorschau

Die Athletenansicht zeigt den Assessment-Status im Abschnitt „Löschantrag“ read-only an. Eine aktive Frist blockiert dort ausdrücklich nur eine spätere irreversible Verarbeitung; Löschantrag, Nutzungssperre und Soft-Delete bleiben davon getrennt. Eine abgelaufene Frist erzeugt keinen automatischen Löschlauf und keine automatische Freigabe.
