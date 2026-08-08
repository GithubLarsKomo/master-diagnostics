# Private Restore Promotion

## Zweck

Nach Reconciliation, DB-Replay, Artifact-Replay und gegebenenfalls Recovery kann die private Restore-Kopie technisch gesund sein. Ein grüner Healthcheck allein darf aber noch keine produktive Umschaltung auslösen.

Die Promotion-Kette trennt deshalb zwei verschiedene Autorisierungsschritte:

1. **Promotion Readiness v1** berechnet read-only, ob der aktuelle private Restore-Evidence-Satz promotionsfähig ist.
2. **Promotion Intent v1** bindet eine positive Readiness anschließend durable, immutable und signiert, bevor ein späterer Promotion-Executor überhaupt existieren darf.

Keiner dieser Schritte führt selbst eine produktive Promotion aus.

## Voraussetzung: frischer Healthcheck

Das Readiness-Gate akzeptiert keinen zuvor gespeicherten Healthcheck-Report. Es berechnet `assessRestorePrivateHealthcheck(...)` bei jeder Prüfung erneut aus:

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

## Promotion Readiness v1

Der Readiness-Report hat zwei Zustände:

- `PROMOTION_READY`
- `BLOCKED`

Nur `PROMOTION_READY` besitzt `promotionAllowed = true`.

Diese positive Entscheidung ist ausdrücklich **nicht durable**:

```text
authorizationScope = PRIVATE_RESTORE_PROMOTION
authorizationPersisted = false
```

Daraus folgt keine allgemeine Runtime- oder Privacy-Autorisierung und noch keine Erlaubnis, produktive Volumes zu verändern.

Blocker umfassen unter anderem:

- `HEALTHCHECK_NOT_HEALTHY`
- `RECONCILIATION_NOT_READY`
- `DATABASE_REPLAY_NOT_SATISFIED`
- `ARTIFACT_REPLAY_NOT_VERIFIED`
- `RECOVERY_EVIDENCE_REQUIRED`
- `RECOVERY_EVIDENCE_UNEXPECTED`
- `RECOVERY_EVIDENCE_INCOMPLETE`
- `RECOVERY_EVIDENCE_INVALID`

### Deterministischer Evidence Fingerprint

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
- Recovery-Intent-Signatur,
- Recovery-Receipt-Signatur,
- Recovery-Abschlusszeitpunkt,
- finale `promotionAllowed`-Entscheidung,
- `authorizationPersisted = false`.

Eine Änderung an einem dieser Inputs erzeugt einen anderen Evidence Fingerprint und verlangt eine neue Readiness-Prüfung.

## Signed Promotion Intent v1

`restore-private-promotion-intent.ts` macht aus einer positiven, noch flüchtigen Readiness einen durable Promotion Intent.

Der Intent besitzt:

```text
phase = AUTHORIZED
authorizationScope = PRIVATE_RESTORE_PROMOTION
sourceAuthorizationPersisted = false
promotionExecuted = false
```

Er bindet:

- Backup-Cutoff,
- Readiness-Version,
- Readiness-Evidence-Fingerprint,
- Healthcheck-Fingerprint,
- Obligations-Fingerprint,
- Artifact-Entries-Fingerprint,
- Recovery-Evidence-Status,
- gegebenenfalls Recovery-Plan-Fingerprint,
- Recovery-Intent-Signatur,
- Recovery-Receipt-Signatur,
- Recovery-Abschlusszeitpunkt,
- einen einmaligen `authorizedAt`-Zeitpunkt.

Der Intent darf ausschließlich aus einem intern konsistenten `PROMOTION_READY`-Report entstehen. Insbesondere müssen Readiness und eingebetteter Healthcheck weiterhin ihre unterschiedlichen Rollen behalten:

```text
Promotion Readiness: promotionAllowed = true
Healthcheck:          promotionAllowed = false
```

Ein `BLOCKED`-Report, ein Report mit Blockern oder ein Report, der bereits `authorizationPersisted=true` behauptet, kann nicht in einen neuen Intent umgewandelt werden.

### Recovery-Bindung

`recoveryEvidenceStatus` ist im Promotion Intent nur in zwei terminalen Formen zulässig:

- `NOT_REQUIRED`: alle Recovery-Felder müssen `null` sein.
- `VERIFIED`: Plan-Fingerprint, Recovery-Intent-Signatur, Completion-Receipt-Signatur und `recoveryCompletedAt` müssen vollständig vorhanden sein.

Eine `MISSING`- oder `INVALID`-Recovery-Evidence kann niemals zur Promotion autorisiert werden.

Zeitlich gilt:

```text
authorizedAt >= backupCutoff
```

und bei Recovery zusätzlich:

```text
authorizedAt >= recoveryCompletedAt
```

## Signatur und Persistenz

Promotion Intent v1 verwendet HMAC-SHA256 mit einer eigenen Domain Separation:

```text
masters:restore-private-promotion-intent:v1
```

Der spätere operative Workflow muss dafür einen **eigenen 32-Byte-Base64-Key** provisionieren. Backup-, Restore-Ledger-, Privacy-Effect-Journal- und Recovery-Key dürfen nicht wiederverwendet werden.

Der Core erzwingt:

- absoluten Key-Pfad,
- reguläre non-symlink Key-Datei,
- absolutes non-symlink Target-Verzeichnis,
- Target-Verzeichnis `0700`,
- Intent-Datei `0600`,
- exklusives Erzeugen,
- HMAC-Prüfung beim Lesen,
- erneute Bindungsprüfung gegen den übergebenen Readiness-Report.

Der Dateiname ist:

```text
promotion-intent.json
```

Ein identischer Retry reused den bestehenden signierten Intent und damit den ursprünglichen `authorizedAt`. Eine Readiness mit verändertem `evidenceFingerprint` kann den vorhandenen Intent nicht übernehmen oder ersetzen.

## Wichtige Trust Boundary

Der Intent-Core **rechnet Promotion Readiness nicht selbst neu aus**. Er validiert die semantische Struktur des übergebenen Reports und bindet dessen Evidence-Fingerprint kryptografisch.

Deshalb muss jeder operative Boundary-Caller unmittelbar vor dem ersten Persistieren:

```text
aktuelle Roh-Evidence
  -> assessRestorePrivatePromotionReadiness(...)
  -> PROMOTION_READY
  -> ensureSignedRestorePrivatePromotionIntent(...)
```

ausführen.

Ein späterer Promotion-Intent-CLI muss genau diese Reihenfolge in einem Prozess erzwingen und darf keinen beliebigen gespeicherten Readiness-JSON-Report als Autorisierungsquelle akzeptieren.

## Sicherheitsgrenze des aktuellen Stands

Der aktuelle Promotion-Stand:

- berechnet Readiness read-only,
- kann die positive Entscheidung immutable/signiert persistieren,
- ändert keine fachliche DB-Zeile,
- stoppt keine produktiven Dienste,
- kopiert keine Restore-Daten in Produktiv-Volumes,
- ändert keine Compose- oder Caddy-Konfiguration,
- setzt `promotionExecuted` niemals auf `true`.

Als nächste Slices folgen:

1. Promotion-Intent-CLI mit frischer Readiness-Berechnung und separater Key-Provisionierung,
2. isoliertes Compose-/Host-Wiring,
3. separat kontrollierter Promotion-Executor,
4. Restore-/Promotion-Audit,
5. praktischer Restore-/RTO-Drill.

Bis Promotion-Executor, Audit und RTO-Drill implementiert und praktisch verifiziert sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
