# Private Restore Promotion Readiness

## Zweck

Nach Reconciliation, DB-Replay, Artifact-Replay und gegebenenfalls Recovery kann die private Restore-Kopie technisch gesund sein. Ein grüner Healthcheck allein darf aber noch keine produktive Umschaltung auslösen.

Promotion Readiness v1 ist deshalb ein **rein read-only Autorisierungs-Gate**. Es verändert weder Dateien noch Datenbankzustand, persistiert keinen Promotion-Intent und schaltet keine produktiven Volumes um.

Erstmals darf ein Restore-Vertrag `promotionAllowed: true` ausgeben. Diese Aussage bedeutet ausschließlich:

> Ein späterer, separat kontrollierter Promotion-Executor darf genau diesen Evidence-Satz als Kandidat verwenden.

Sie ist selbst noch keine Promotion.

## Voraussetzung: frischer Healthcheck

Das Gate akzeptiert keinen zuvor gespeicherten Healthcheck-Report. Es berechnet `assessRestorePrivateHealthcheck(...)` bei jeder Prüfung erneut aus:

- aktueller signierter Restore-Reconciliation,
- privater Restore-DB,
- Artifact-Replay-Manifest,
- Artifact-Replay-Result,
- den drei privaten Artifact-Roots.

Nur wenn der Report gleichzeitig

- `status = HEALTHY`,
- `healthcheckPassed = true`,
- `readyForPromotionReview = true`,
- `databaseStatus = DATABASE_SATISFIED`,
- `artifactManifestVerified = true`,
- `artifactReplayVerified = true`

meldet, kann Promotion Readiness überhaupt positiv werden.

Der Healthcheck selbst bleibt bewusst bei `promotionAllowed = false`.

## Recovery darf nicht durch fehlende Dateien unsichtbar werden

Ein fehlender Recovery-Plan ist kein ausreichender Beweis dafür, dass keine Recovery stattgefunden hat.

Das Gate sucht deshalb in der privaten Restore-DB nach Evidence des **aktuellen Restore-Zeitraums**:

- Audit-Ereignisse mit `source = RESTORE_RECOVERY` und `occurredAt >= backupCutoff`,
- vom Healthcheck akzeptierte Restore-Normalisierungen.

Historische Restore-Audits aus früheren, bereits produktiven Restores liegen bei einem später erzeugten Backup vor dessen neuem Cutoff und werden dadurch nicht als aktuelle Recovery fehlklassifiziert.

Wird aktuelle Recovery erkannt, aber der vollständige Recovery-Evidence-Satz fehlt, blockiert das Gate fail-closed.

## Vollständige Recovery-Evidence

Für einen Restore mit Recovery müssen gemeinsam vorliegen:

- persistierter Recovery Plan v1,
- signierter PENDING Recovery Intent v1,
- signierter Completion Receipt v1,
- Recovery-HMAC-Key zur erneuten Verifikation.

Teilweise vorhandene Evidence ist nicht zulässig.

Der Receipt-Reader verifiziert erneut:

- Plan gegen aktuelle Reconciliation,
- Intent-Signatur und Plan-Bindung,
- Receipt-Signatur,
- Recovery-Start und -Abschluss,
- terminale Evidenzklasse jeder geplanten Action.

Zusätzlich prüft Promotion Readiness die tatsächlichen privaten DB-Effekte.

### Abort und Completion

Für

- `ABORT_PREPARING`,
- `RESTORE_ARTIFACTS_AND_ABORT`,
- `PURGE_ARTIFACTS_AND_COMPLETE`

müssen die seit dem aktuellen Backup-Cutoff vorhandenen `RESTORE_RECOVERY`-Audit-Events exakt den geplanten Executions entsprechen.

Die `correlationId` jedes Events muss genau dem Recovery-Plan-Fingerprint entsprechen. Zusätzliche, fehlende oder fremd gebundene Recovery-Audits blockieren.

### Restore-Normalisierung

Für `PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE` muss der frisch berechnete Healthcheck genau die im Plan erwarteten normalisierten Executions ausweisen. Jede akzeptierte Normalisierung muss bereits durch den Healthcheck an aktuellen Cutoff, Reconciliation-Obligation und Plan-Fingerprint gebunden sein.

## Promotion-Readiness-Report

Der Report hat zwei Zustände:

- `PROMOTION_READY`
- `BLOCKED`

Nur `PROMOTION_READY` besitzt `promotionAllowed = true`.

Die Autorisierung ist auf

```text
PRIVATE_RESTORE_PROMOTION
```

begrenzt. Daraus folgt keine allgemeine Runtime- oder Privacy-Autorisierung.

Blocker umfassen unter anderem:

- `HEALTHCHECK_NOT_HEALTHY`
- `RECONCILIATION_NOT_READY`
- `DATABASE_REPLAY_NOT_SATISFIED`
- `ARTIFACT_REPLAY_NOT_VERIFIED`
- `RECOVERY_EVIDENCE_REQUIRED`
- `RECOVERY_EVIDENCE_UNEXPECTED`
- `RECOVERY_EVIDENCE_INCOMPLETE`
- `RECOVERY_EVIDENCE_INVALID`

## Deterministischer Evidence Fingerprint

Promotion Readiness erzeugt einen `evidenceFingerprint` über den aktuellen autorisierungsrelevanten Evidence-Satz:

- Backup-Cutoff,
- Reconciliation-Status,
- Ledger-Zeitpunkt und Ledger-Entries-Fingerprint,
- Journal-Markerzahl,
- Fingerprint aller Replay-Obligations,
- Artifact-Manifest-Version und Entries-Fingerprint,
- Artifact-Result-Version und Zahl verifiziert abwesender Einträge,
- Fingerprint des frisch berechneten vollständigen Healthchecks,
- Recovery-Evidence-Status,
- gegebenenfalls Plan-Fingerprint,
- Intent-Signatur,
- Receipt-Signatur,
- Recovery-Abschlusszeitpunkt,
- finale `promotionAllowed`-Entscheidung.

Eine Änderung an einem dieser Inputs erzeugt einen anderen Evidence Fingerprint und verlangt eine neue Readiness-Prüfung.

## Sicherheitsgrenze dieses Slices

Promotion Readiness v1:

- schreibt keine Datei,
- ändert keine DB-Zeile,
- erzeugt keinen Promotion-Intent,
- stoppt keine produktiven Dienste,
- kopiert keine Restore-Daten in Produktiv-Volumes,
- ändert keine Compose- oder Caddy-Konfiguration.

Der nächste Slice soll die positive Readiness-Entscheidung in einen **immutable/signierten Promotion Intent** binden. Erst ein weiterer, separat kontrollierter Executor darf danach die eigentliche Promotion durchführen.

Bis Promotion-Executor, Restore-/Promotion-Audit und praktischer RTO-Drill implementiert und verifiziert sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
