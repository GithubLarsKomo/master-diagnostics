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

## UI-Vorschau

Die Athletenansicht zeigt den Assessment-Status im Abschnitt „Löschantrag“ read-only an. Eine aktive Frist blockiert dort ausdrücklich nur eine spätere irreversible Verarbeitung; Löschantrag, Nutzungssperre und Soft-Delete bleiben davon getrennt. Eine abgelaufene Frist erzeugt keinen Ausführungsbutton und keine automatische Freigabe.

## Nächste Schritte

1. Geplanten Retention-Job auf Basis der read-only Worklist ergänzen, zunächst ohne irreversible Datenänderung.
2. Pseudonymisierungsstrategie und Audit-Anforderungen definieren.
3. Erst danach einen irreversiblen Writer implementieren.
