# Private Restore Promotion

## Zweck

Eine private Restore-Kopie darf erst promotionsfähig werden, nachdem Reconciliation, DB-Replay, Artifact-Replay, gegebenenfalls Recovery und ein frischer Healthcheck vollständig konsistent sind. Auch dann wird die eigentliche produktive Umschaltung bewusst von der Autorisierung getrennt.

Die aktuelle Promotion-Kette besteht aus drei Stufen:

1. **Promotion Readiness v1** bewertet aktuelle Restore-Evidence read-only.
2. **Signed Promotion Intent v1** persistiert eine positive Readiness immutable und signiert.
3. **Promotion-Intent CLI** berechnet Readiness direkt aus aktueller Roh-Evidence und persistiert den Intent im selben Prozess.

Keine dieser Stufen kopiert Restore-Daten in Produktiv-Volumes oder führt eine Promotion aus.

## Promotion Readiness v1

`assessRestorePrivatePromotionReadiness(...)` berechnet den Private-Restore-Healthcheck bei jeder Prüfung neu. Ein zuvor gespeicherter Healthcheck wird nicht als Autorisierungsquelle akzeptiert.

Promotion Readiness kann nur positiv sein, wenn insbesondere:

- Reconciliation nicht blockiert und `reconciliationReady=true` ist,
- die private Restore-DB `DATABASE_SATISFIED` ist,
- Artifact-Replay-Manifest und -Result erneut verifiziert sind,
- der frische Healthcheck `HEALTHY` meldet,
- `healthcheckPassed=true`,
- `readyForPromotionReview=true`,
- keine Healthcheck-Blocker existieren.

Der Healthcheck selbst bleibt bei `promotionAllowed=false`. Erst Promotion Readiness darf bei vollständiger Evidence `promotionAllowed=true` melden.

Die positive Readiness bleibt ausdrücklich nicht durable:

```text
authorizationScope = PRIVATE_RESTORE_PROMOTION
authorizationPersisted = false
```

## Recovery-Erkennung

Ein fehlender `recovery-plan.json` ist kein ausreichender Beweis, dass keine Recovery stattgefunden hat.

Promotion Readiness erkennt Recovery des aktuellen Restore-Zeitraums zusätzlich über:

- `RESTORE_RECOVERY`-Audit-Ereignisse mit `occurredAt >= backupCutoff`,
- vom Healthcheck akzeptierte Restore-Normalisierungen.

Bei erkannter Recovery müssen vollständig vorliegen:

- Recovery Plan v1,
- signierter PENDING Recovery Intent v1,
- signierter Recovery Completion Receipt v1,
- Recovery-HMAC-Key zur erneuten Verifikation.

Teilweise Recovery-Evidence blockiert fail-closed.

Für Abort-/Completion-Actions müssen die aktuellen `RESTORE_RECOVERY`-Audit-Events exakt den geplanten Executions und dem Plan-Fingerprint als `correlationId` entsprechen. Für `PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE` müssen die vom Healthcheck akzeptierten Normalisierungen exakt den geplanten Executions entsprechen.

## Readiness Evidence Fingerprint

Der `evidenceFingerprint` bindet deterministisch die autorisierungsrelevante Restore-Evidence, darunter:

- Backup-Cutoff,
- Reconciliation-/Ledger-/Journal-Evidence,
- Replay-Obligations,
- Artifact-Manifest/-Result-Evidence,
- Fingerprint des frisch berechneten Healthchecks,
- Recovery-Evidence-Status,
- gegebenenfalls Recovery-Plan-/Intent-/Receipt-Evidence,
- Recovery-Abschlusszeitpunkt,
- `promotionAllowed`,
- `authorizationPersisted=false`.

Ändert sich ein gebundener Input, entsteht ein anderer Evidence Fingerprint.

## Signed Promotion Intent v1

Der Promotion Intent besitzt:

```text
phase = AUTHORIZED
authorizationScope = PRIVATE_RESTORE_PROMOTION
sourceAuthorizationPersisted = false
promotionExecuted = false
```

Er bindet insbesondere:

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
- stabilen `authorizedAt`-Zeitpunkt.

Ein Intent darf nur aus einem intern konsistenten `PROMOTION_READY`-Report entstehen. `BLOCKED`, vorhandene Blocker, `authorizationPersisted=true`, ungelöste Recovery-Evidence oder ein nicht gesunder eingebetteter Healthcheck werden abgelehnt.

Zeitlich gilt:

```text
authorizedAt >= backupCutoff
```

und bei Recovery zusätzlich:

```text
authorizedAt >= recoveryCompletedAt
```

### Signatur und Persistenz

Promotion Intent v1 verwendet HMAC-SHA256 mit eigener Domain Separation:

```text
masters:restore-private-promotion-intent:v1
```

Der Promotion-Key muss ein eigener 32-Byte-Base64-Key sein. Backup-, Ledger-, Journal- und Recovery-Key dürfen nicht wiederverwendet werden.

Der Core erzwingt:

- absoluten Key-Pfad,
- reguläre non-symlink Key-Datei,
- absolutes non-symlink Target-Verzeichnis,
- Target-Verzeichnis `0700`,
- `promotion-intent.json` mit `0600`,
- exklusives Erzeugen,
- HMAC-Prüfung beim Lesen,
- erneute Bindungsprüfung gegen die Readiness-Evidence.

Ein identischer Retry reused den bestehenden signierten Intent und den ursprünglichen `authorizedAt`. Eine geänderte Readiness kann einen vorhandenen Intent nicht übernehmen.

## Promotion-Intent CLI

Der operative Einstiegspunkt lautet:

```bash
pnpm --filter @masters/db backup:restore-promotion-intent
```

Der CLI akzeptiert bewusst **keine gespeicherte Readiness-Datei**. Er rekonstruiert im selben Prozess:

1. Backup-Cutoff aus dem Staging-Manifest,
2. aktuelle signierte Ledger-/Journal-Reconciliation,
3. Artifact-Replay-Manifest und -Result,
4. Recovery-Evidence aus Plan, PENDING Intent und Completion Receipt,
5. aktuelle private DB und Artifact-Roots,
6. einen frischen Promotion-Readiness-Report.

Erst bei `PROMOTION_READY` werden Promotion-Intent-Target und Promotion-Key benötigt und der signierte Intent persistiert.

### Blockierter Lauf

Bei nicht promotionsfähiger Evidence liefert der CLI:

```text
mode = ISOLATED_RESTORE_PROMOTION_INTENT
status = BLOCKED
promotionAllowed = false
authorizationPersisted = false
promotionExecuted = false
```

und beendet sich mit Exit `3`.

Der Promotion-Key wird in diesem Pfad nicht gelesen und es wird kein Promotion-Verzeichnis erzeugt.

### Autorisierter Lauf

Bei vollständiger Evidence liefert der CLI unter anderem:

```text
mode = ISOLATED_RESTORE_PROMOTION_INTENT
status = AUTHORIZED
promotionAllowed = true
authorizationPersisted = true
promotionExecuted = false
```

sowie:

- Backup-Cutoff,
- Readiness-Evidence-Fingerprint,
- `intentCreated` / `intentReused`,
- stabilen `authorizedAt`,
- Intent-Signatur.

Ein Retry berechnet die aktuelle Readiness erneut. Nur wenn sie weiterhin exakt zum vorhandenen Intent passt, wird derselbe Intent wiederverwendet.

## Recovery-Evidence im CLI

Der CLI betrachtet Plan, Recovery Intent und Completion Receipt gemeinsam:

- keine dieser Dateien vorhanden: Readiness entscheidet anhand DB-/Normalization-Evidence, ob Recovery wirklich nicht erforderlich war,
- nur ein Teil vorhanden: unvollständige Recovery-Evidence blockiert,
- vollständiger Satz vorhanden: Readiness verifiziert ihn erneut kryptografisch und gegen aktuelle DB-Effekte.

Damit kann das Entfernen von `recovery-plan.json` eine bereits durch Audit-/Normalization-Evidence erkennbare Recovery nicht verstecken.

## Server-Contract

`Restore Promotion Intent Contract` baut eine echte private libSQL-Restore-DB mit Migrationen und signierter Restore-Evidence auf.

Der Contract beweist mindestens:

- fehlendes Artifact-Result führt zu Exit `3`,
- im blockierten Pfad wird kein Promotion-Verzeichnis angelegt,
- gesunde Restore-Evidence erzeugt einen signierten Promotion Intent,
- der zweite Lauf reused den Intent,
- `authorizedAt`, Evidence-Fingerprint und Signatur bleiben stabil,
- Rechte bleiben `0700/0600`,
- `promotionExecuted=false` bleibt unverändert.

## Aktuelle Sicherheitsgrenze

Der aktuelle Stand kann eine Promotion prüfen und durable autorisieren, aber nicht ausführen. Insbesondere:

- keine produktiven Dienste werden gestoppt,
- keine produktiven DB-/Report-/Export-Volumes werden verändert,
- keine Compose-/Caddy-Umschaltung erfolgt,
- kein Promotion-Executor existiert,
- `promotionExecuted` wird niemals auf `true` gesetzt.

Als nächste Slices folgen:

1. separater Promotion-Key in Deployment-Konfiguration sowie isoliertes Compose-/Host-Wiring für den Intent-CLI,
2. separat kontrollierter Promotion-Executor mit erneut verifizierter Intent-/Workspace-Evidence,
3. Restore-/Promotion-Audit,
4. praktischer Restore-/RTO-Drill.

Bis Promotion-Executor, Audit und RTO-Drill implementiert und praktisch verifiziert sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
