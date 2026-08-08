# Private Restore Promotion

## Zweck

Eine private Restore-Kopie darf erst promotionsfähig werden, nachdem Reconciliation, DB-Replay, Artifact-Replay, gegebenenfalls Recovery und ein frischer Healthcheck vollständig konsistent sind. Die produktive Umschaltung bleibt davon bewusst getrennt.

Die aktuelle Promotion-Kette besteht aus fünf Stufen:

1. **Promotion Readiness v1** bewertet aktuelle Restore-Evidence read-only.
2. **Signed Promotion Intent v1** bindet eine positive Readiness immutable und signiert.
3. **Promotion-Intent CLI** berechnet Readiness direkt aus Roh-Evidence und persistiert den Intent im selben Prozess.
4. **Isoliertes Promotion-Intent Wiring** stellt einen expliziten Host-Befehl, einen eigenen Secret-Key und einen minimal beschreibbaren Compose-Service bereit.
5. **Promotion Execution Preflight v1** rekonstruiert unmittelbar vor einer späteren Produktivmutation dieselbe Roh-Evidence erneut und akzeptiert den signierten Intent nur, wenn er noch exakt dazu passt.

Keine dieser Stufen führt bereits eine produktive Promotion aus.

## Promotion Readiness v1

`assessRestorePrivatePromotionReadiness(...)` berechnet den Private-Restore-Healthcheck bei jeder Prüfung neu. Ein gespeicherter Healthcheck wird nicht als Autorisierungsquelle akzeptiert.

Promotion Readiness kann nur positiv sein, wenn unter anderem:

- Reconciliation nicht blockiert und `reconciliationReady=true` ist,
- die private Restore-DB `DATABASE_SATISFIED` ist,
- Artifact-Replay-Manifest und -Result erneut verifiziert sind,
- der frische Healthcheck `HEALTHY` meldet,
- `healthcheckPassed=true`,
- `readyForPromotionReview=true`,
- keine Healthcheck-Blocker existieren.

Der Healthcheck selbst bleibt bei `promotionAllowed=false`. Erst Promotion Readiness darf bei vollständiger Evidence `promotionAllowed=true` melden. Diese positive Readiness bleibt nicht durable:

```text
authorizationScope = PRIVATE_RESTORE_PROMOTION
authorizationPersisted = false
```

## Recovery-Erkennung

Ein fehlender `recovery-plan.json` ist kein ausreichender Beweis, dass keine Recovery stattgefunden hat.

Promotion Readiness erkennt Recovery des aktuellen Restore-Zeitraums zusätzlich über:

- `RESTORE_RECOVERY`-Audit-Ereignisse mit `occurredAt >= backupCutoff`,
- vom Healthcheck akzeptierte Restore-Normalisierungen.

Bei erkannter Recovery müssen Recovery Plan v1, signierter PENDING Recovery Intent v1, signierter Recovery Completion Receipt v1 und der Recovery-HMAC-Key vollständig verifizierbar sein. Teilweise Evidence blockiert fail-closed.

## Readiness Evidence Fingerprint

Der `evidenceFingerprint` bindet deterministisch die autorisierungsrelevante Restore-Evidence, unter anderem Backup-Cutoff, Reconciliation-/Ledger-/Journal-Evidence, Replay-Obligations, Artifact-Evidence, den frisch berechneten Healthcheck sowie gegebenenfalls Recovery-Plan-/Intent-/Receipt-Evidence.

Ändert sich ein gebundener Input, entsteht ein anderer Evidence Fingerprint.

## Gemeinsame Roh-Evidence-Rekonstruktion

Autorisierung und Execution Preflight verwenden denselben Service:

```text
restore-private-promotion-storage.ts
```

Er rekonstruiert Promotion Readiness ausschließlich aus den aktuellen technischen Quellen:

- Staging-Manifest,
- signiertem Restore Privacy Ledger,
- Privacy Effect Journal,
- Artifact-Replay-Manifest/-Result,
- privater Restore-DB,
- privaten Artifact-Roots,
- optionaler Recovery-Evidence.

Die Umgebungsvariablen werden ebenfalls durch eine gemeinsame kanonische Mapping-Funktion in absolute Pfade überführt. Dadurch können Autorisierungs-CLI und Preflight nicht versehentlich unterschiedliche Interpretationen derselben Restore-Evidence entwickeln.

## Signed Promotion Intent v1

Der Promotion Intent besitzt:

```text
phase = AUTHORIZED
authorizationScope = PRIVATE_RESTORE_PROMOTION
sourceAuthorizationPersisted = false
promotionExecuted = false
```

Er bindet Backup-Cutoff, Readiness-Version und -Fingerprint, Healthcheck-/Obligations-/Artifact-Fingerprints, Recovery-Evidence sowie den stabilen `authorizedAt`-Zeitpunkt.

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

Der Promotion-Key ist ein eigener 32-Byte-Base64-Key. Backup-, Ledger-, Journal- und Recovery-Key dürfen nicht wiederverwendet werden.

Der Core erzwingt absolute non-symlink Pfade, `0700` für das Target-Verzeichnis, `0600` für `promotion-intent.json`, exklusives Erzeugen, HMAC-Verifikation und exakte Readiness-Bindung. Ein identischer Retry reused den ursprünglichen `authorizedAt`.

## Promotion-Intent CLI

Der operative Einstiegspunkt im Container lautet:

```bash
pnpm --filter @masters/db backup:restore-promotion-intent
```

Der CLI akzeptiert keine gespeicherte Readiness-Datei. Er rekonstruiert im selben Prozess die aktuelle Roh-Evidence und daraus Promotion Readiness.

Bei Blockade liefert er Exit `3` mit:

```text
status = BLOCKED
promotionAllowed = false
authorizationPersisted = false
promotionExecuted = false
```

Bei vollständiger Evidence persistiert er den Intent und liefert unter anderem:

```text
status = AUTHORIZED
promotionAllowed = true
authorizationPersisted = true
promotionExecuted = false
```

Ein Retry berechnet Readiness erneut und reused nur einen weiterhin exakt passenden Intent.

## Unabhängiger Promotion-Key

Die Club-Konfiguration enthält einen fünften unabhängigen Restore-/Privacy-Key:

```text
RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE=/etc/master-diagnostics/restore-private-promotion.key
```

Erzeugung beispielsweise:

```bash
openssl rand -base64 32
```

Dieser Key darf nicht mit Backup-, Restore-Ledger-, Privacy-Effect-Journal- oder Recovery-Intent-Key identisch sein.

## Isoliertes Promotion-Intent Wiring

Der Promotion-Intent-Service liegt in einem separaten Override:

```text
infra/docker-compose.restore-promotion.yml
```

Service:

```text
backup-restore-promotion-intent
```

Er nutzt ausschließlich die private Restore-DB und `restore-internal`. Der gesamte per-staging Restore-Workspace wird read-only gemountet; ausschließlich `/restore-replay/promotion` wird als engerer RW-Bind überlagert. Produktive DB-, Report-, Export-, Delivery- und Caddy-Targets werden nicht gemountet.

Der Recovery-Key wird nicht statisch exponiert. Ein sicher vorhandener Key wird vom Host-Befehl dynamisch read-only eingebunden; ohne Key bleibt erkannte Recovery fail-closed.

Promotion-Autorisierung ist ein separater Schritt:

```bash
bash infra/backup/authorize-club-restore-promotion.sh restore-<timestamp>-<uuid>
```

Der Wrapper führt keine Artifact-Replay-Planung, keinen DB-Replay, keinen Artifact-Replay und keine Recovery erneut aus.

## Promotion Execution Preflight v1

Eine einmal erteilte Promotion-Autorisierung ist **kein zeitlich unbegrenztes Ticket**. Zwischen `authorizedAt` und einer späteren Downtime können sich private Restore-Evidence, externe Ledger-/Journal-Evidence oder der Workspace ändern.

Deshalb muss ein späterer Promotion-Executor unmittelbar vor der ersten Produktivmutation den Execution Preflight ausführen.

Service:

```text
assessRestorePrivatePromotionExecutionPreflight(...)
```

CLI:

```bash
pnpm --filter @masters/db backup:restore-promotion-preflight
```

### Ablauf

Der Preflight:

1. rekonstruiert Promotion Readiness erneut aus aktueller Roh-Evidence,
2. verlangt erneut `PROMOTION_READY`,
3. liest den durable Promotion Intent,
4. verifiziert HMAC, Dateipfad und Intent-Struktur,
5. bindet den Intent erneut an den **aktuellen** Readiness-Evidence-Fingerprint,
6. bestätigt weiterhin `promotionExecuted=false`,
7. erzeugt ausschließlich einen read-only `executionFingerprint`.

Der Preflight schreibt keine Datei und ändert weder private noch produktive Daten.

### Erfolgszustand

Nur bei vollständiger Übereinstimmung entsteht:

```text
status = EXECUTION_READY
authorizationScope = PRIVATE_RESTORE_PROMOTION
promotionAllowed = true
authorizationPersisted = true
promotionExecuted = false
```

Zusätzlich werden gebunden:

- Backup-Cutoff,
- aktueller Readiness-Evidence-Fingerprint,
- aktueller Healthcheck-Fingerprint,
- Intent-Signatur,
- ursprünglicher `authorizedAt`,
- deterministischer `executionFingerprint`.

Zwei Preflights über unveränderte Evidence und denselben Intent liefern denselben Execution Fingerprint.

### Stale-Intent-Schutz

Wenn sich nach der Autorisierung die Roh-Evidence ändert, wird nicht versucht, den alten Intent an einen neuen Zustand anzupassen.

Beispiel aus dem Server-Contract:

```text
Promotion Intent gültig
-> Artifact-Replay-Result wird entfernt
-> frische Readiness = BLOCKED
-> Preflight Exit 3
-> keine Execution-Freigabe
```

Der Executor darf in diesem Fall weder Downtime beginnen noch produktive Volumes verändern. Zuerst müsste die Restore-Evidence wieder vollständig hergestellt und eine passende Autorisierung erzeugt werden.

## Server-Contracts

`Restore Promotion Intent Contract` prüft mit echter libSQL-DB und signierter Restore-Evidence:

- Blockade ohne Persistenz,
- idempotente Promotion-Intent-Wiederverwendung,
- zwei identische erfolgreiche Execution Preflights,
- identische Execution Fingerprints bei unveränderter Evidence,
- sofortige Blockade desselben Intents nach Veränderung der Roh-Evidence.

`Restore Promotion Wiring Contract` prüft die isolierte Host-/Compose-Grenze, insbesondere read-only Restore-Workspace, ausschließlich schreibbares `promotion/`, fehlende Produktiv-Mounts und keine Replay-/Recovery-Neuausführung.

## Aktuelle Sicherheitsgrenze

Der aktuelle Stand kann eine Promotion prüfen, durable autorisieren und unmittelbar vor einer späteren Ausführung erneut read-only freigeben, aber noch nicht ausführen. Insbesondere:

- keine produktiven Dienste werden gestoppt,
- keine produktiven DB-/Report-/Export-Volumes werden verändert,
- keine Caddy-Umschaltung erfolgt,
- kein mutierender Promotion-Executor existiert,
- `promotionExecuted` bleibt immer `false`.

Als nächste Slices folgen:

1. produktive Promotion-Architektur mit versionierten Kandidaten-/Rollback-Volumes und expliziter Umschaltgrenze,
2. mutierender Promotion-Executor erst auf Basis dieser Architektur und eines unmittelbar grünen Preflights,
3. Restore-/Promotion-Audit,
4. praktischer Restore-/RTO-Drill.

Bis Promotion-Executor, Audit und RTO-Drill implementiert und praktisch verifiziert sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
