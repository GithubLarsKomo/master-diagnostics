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

`listTenantRetentionCandidates()` baut eine deterministische, tenantgebundene und vollständig read-only Worklist für einen späteren Retention-Job:

- Athleten mit noch aktiver Aufbewahrungsfrist werden nicht aufgenommen.
- Abgelaufene Assessments erhalten `disposition = ELIGIBLE`.
- Fail-closed-Fälle erhalten `disposition = MANUAL_REVIEW` und bleiben für automatisierte irreversible Verarbeitung gesperrt.
- Die Ausgabe ist nach `athleteId` stabil sortiert und enthält zusätzlich `consentBlockedAt` und `deletedAt`, damit ein späterer Writer seine weiteren Schutzbedingungen prüfen kann.
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

Die Ausgabe erfolgt als JSON auf `stdout` und kann dadurch von Cron, systemd timer oder einer späteren Betriebssteuerung aufgenommen werden. Die konkrete produktive Zeitplanung gehört zum Deployment-/Betriebskonzept; der fachliche Job selbst bleibt davon entkoppelt.

Wichtig: Auch ein im Job als `ELIGIBLE` geführter Datensatz wird **nicht** verändert. Vor einem späteren irreversiblen Writer müssen mindestens Löschworkflow/Freigabe, Schutzbedingungen, Pseudonymisierungsstrategie und Audit-Semantik separat geprüft werden.

## UI-Vorschau

Die Athletenansicht zeigt den Assessment-Status im Abschnitt „Löschantrag“ read-only an. Eine aktive Frist blockiert dort ausdrücklich nur eine spätere irreversible Verarbeitung; Löschantrag, Nutzungssperre und Soft-Delete bleiben davon getrennt. Eine abgelaufene Frist erzeugt keinen Ausführungsbutton und keine automatische Freigabe.

## Nächste Schritte

1. Pseudonymisierungsstrategie und Audit-Anforderungen definieren.
2. Read-only Freigabe-/Schutzprüfung für einen späteren irreversiblen Writer ergänzen.
3. Erst danach einen irreversiblen Writer implementieren.
