# Private Restore Promotion

## Zweck

Eine private Restore-Kopie darf erst promotionsfähig werden, nachdem Reconciliation, DB-Replay, Artifact-Replay, gegebenenfalls Recovery und ein frischer Healthcheck vollständig konsistent sind. Die produktive Umschaltung bleibt davon bewusst getrennt.

Die aktuelle Promotion-Kette besteht aus vier Stufen:

1. **Promotion Readiness v1** bewertet aktuelle Restore-Evidence read-only.
2. **Signed Promotion Intent v1** bindet eine positive Readiness immutable und signiert.
3. **Promotion-Intent CLI** berechnet Readiness direkt aus Roh-Evidence und persistiert den Intent im selben Prozess.
4. **Isoliertes Promotion-Intent Wiring** stellt dafür einen expliziten Host-Befehl, einen eigenen Secret-Key und einen minimal beschreibbaren Compose-Service bereit.

Keine dieser Stufen führt eine produktive Promotion aus.

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

Der CLI akzeptiert keine gespeicherte Readiness-Datei. Er rekonstruiert im selben Prozess Backup-Cutoff, signierte Reconciliation, Artifact-Replay-Evidence, Recovery-Evidence, private DB-/Artifact-Zustände und daraus die aktuelle Promotion Readiness.

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

Die Club-Konfiguration enthält nun einen fünften unabhängigen Restore-/Privacy-Key:

```text
RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE=/etc/master-diagnostics/restore-private-promotion.key
```

Erzeugung beispielsweise:

```bash
openssl rand -base64 32
```

Dieser Key darf nicht mit Backup-, Restore-Ledger-, Privacy-Effect-Journal- oder Recovery-Intent-Key identisch sein.

## Isoliertes Compose-Wiring

Der Promotion-Intent-Service liegt in einem separaten Override:

```text
infra/docker-compose.restore-promotion.yml
```

Service:

```text
backup-restore-promotion-intent
```

Er nutzt ausschließlich die private Restore-DB über `backup-privacy-replay-db` und ausschließlich das interne Netzwerk `restore-internal`.

### Mount-Grenze

Read-only eingebunden werden:

- Restore-Staging,
- Restore Privacy Ledger,
- Ledger-Key,
- Privacy Effect Journal,
- Journal-Key,
- Promotion-Key,
- der komplette private per-staging Restore-Workspace unter `/restore-replay`.

Nur ein engerer Unterpfad überlagert den read-only Workspace schreibbar:

```text
/restore-replay/promotion
```

Damit kann der Service den signierten Promotion Intent schreiben, aber weder private DB-Dateien noch Reports, Tenant-Exports, Betroffenenexporte, Artifact-Replay-Evidence, Recovery-Plan oder Recovery-Receipt verändern.

Produktive Targets wie `/var/lib/sqld`, `/var/lib/masters/reports`, `/var/lib/masters/exports`, `/var/lib/masters/data-subject-delivery-packages`, Caddy `/data` oder `/config` werden nicht gemountet.

Der Recovery-Key wird absichtlich **nicht statisch** in den Service gemountet. Er wird vom Host-Wrapper nur dann zusätzlich read-only exponiert, wenn eine sichere Key-Datei vorhanden ist. Fehlt der Key trotz Recovery-Evidence, bleibt das Readiness-Gate fail-closed.

## Expliziter Host-Befehl

Promotion-Autorisierung ist ein separater operativer Schritt:

```bash
bash infra/backup/authorize-club-restore-promotion.sh restore-<timestamp>-<uuid>
```

Der Wrapper:

1. validiert den exakten Restore-Staging-Namen,
2. lädt die vertrauenswürdige `.env`,
3. prüft Staging-Manifest und bestehenden privaten Restore-Workspace,
4. verlangt vorhandene Artifact-Replay-Manifest/-Result-Evidence,
5. prüft Promotion-Key und vorhandene Recovery-Evidence auf non-symlink reguläre Pfade,
6. erzeugt nur `${workspace}/promotion` als `0700`,
7. startet/migriert ausschließlich die private Restore-DB,
8. ruft ausschließlich `backup-restore-promotion-intent` auf.

Er führt **keine** Artifact-Replay-Planung, keinen DB-Replay, keinen Artifact-Replay und keine Recovery erneut aus. Damit kann ein bereits autorisierungsreifer Workspace nicht während der Autorisierung neu klassifiziert oder verändert werden.

Ein sicher vorhandener Recovery-Key wird dynamisch read-only in den CLI-Container gemountet. Ist kein Recovery-Key vorhanden, läuft der CLI ohne ihn; erkannte Recovery oder partielle Recovery-Evidence führt dann im Readiness-Gate zu einer Blockade statt zu einer heuristischen Freigabe.

## Server-Contracts

`Restore Promotion Intent Contract` prüft den CLI mit echter libSQL-DB, Migrationen und signierter Restore-Evidence. Er beweist unter anderem Blockade ohne Persistenz und idempotente Intent-Wiederverwendung.

`Restore Promotion Wiring Contract` prüft zusätzlich statisch:

- Bash-Syntax und explizite Host-Grenze,
- Migration vor Autorisierung,
- keine erneute Replay-/Recovery-Ausführung,
- private Restore-DB als einzige Service-Abhängigkeit,
- ausschließlich `restore-internal`,
- gesamter Restore-Workspace read-only,
- nur `/restore-replay/promotion` schreibbar,
- Promotion-Key read-only,
- Recovery-Key nicht statisch gemountet,
- keine produktiven Volume-Targets.

## Aktuelle Sicherheitsgrenze

Der aktuelle Stand kann eine Promotion prüfen und durable autorisieren, aber nicht ausführen. Insbesondere:

- keine produktiven Dienste werden gestoppt,
- keine produktiven DB-/Report-/Export-Volumes werden verändert,
- keine Caddy-Umschaltung erfolgt,
- kein Promotion-Executor existiert,
- `promotionExecuted` bleibt immer `false`.

Als nächste Slices folgen:

1. separat kontrollierter Promotion-Executor mit erneuter Intent-/Workspace-Verifikation und crash-sicherer Umschaltung,
2. Restore-/Promotion-Audit,
3. praktischer Restore-/RTO-Drill.

Bis Promotion-Executor, Audit und RTO-Drill implementiert und praktisch verifiziert sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
