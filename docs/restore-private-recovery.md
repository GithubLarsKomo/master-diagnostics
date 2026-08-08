# Private Restore Recovery

## Zweck

Ein Backup kann eine irreversible Anonymisierung mitten in ihrem mehrstufigen Ablauf enthalten. Nach Restore-Reconciliation, DB-Replay und Artifact-Replay können deshalb historische `PREPARING`-, `ARTIFACTS_STAGED`- oder `DB_COMMITTED`-Zeilen sowie `.anonymization-quarantine`-Dateien übrig bleiben.

Die Recovery-Kette arbeitet ausschließlich auf der privaten Restore-Kopie. Produktive DB-, Report-, Export-, Delivery- und Caddy-Volumes werden nicht gemountet.

Der aktuelle Vertrag besteht aus vier getrennten Stufen:

1. **Recovery Assessment** entscheidet read-only, ob und in welche Richtung ein historischer Zwischenzustand auflösbar ist.
2. **Recovery Plan v1** bindet diese Entscheidung deterministisch und crash-retrybar an exakte Artifact-Referenzen.
3. **Signed Recovery Intent v1** bindet vor der ersten Mutation genau einen stabilen Recovery-Startzeitpunkt an den Plan.
4. **Recovery Executor** setzt ausschließlich diesen persistierten Plan auf der privaten Kopie um; danach muss derselbe read-only Healthcheck erneut `HEALTHY` melden.

Keine dieser Stufen erlaubt eine Promotion. `promotionAllowed` bleibt überall `false`.

## Zentrale Prioritätsregel

Signierte post-backup Privacy-Evidenz ist autoritativer als der ältere Snapshot-Zustand.

Beispiel:

```text
Backup-Cutoff:          Execution = ARTIFACTS_STAGED
nach dem Backup:        dieselbe Execution wird produktiv DB_COMMITTED
aktuelle Evidenz:       Ledger + Journal bestätigen COMMITTED
Restore-Reconciliation: post-backup Obligation für dieselbe Execution
```

In diesem Fall darf der Restore die Quarantäne niemals zurückrollen. Das würde bereits wirksam gelöschte personenbezogene Daten wiederherstellen. Die einzige zulässige Richtung ist vorwärts: DB-Replay anwenden, verbleibende Artifact-Kopien purgen und den historischen Snapshot mit immutable Restore-Normalisierungsevidenz abschließen.

## Recovery-Klassen

Der Assessment-/Plan-Vertrag kennt vier Aktionen:

- `ABORT_PREPARING`: alter PREPARING-Zustand, keine post-backup COMMITTED-Evidenz, alle Manifest-Artefakte noch aktiv.
- `RESTORE_ARTIFACTS_AND_ABORT`: keine COMMITTED-Evidenz; quarantänisierte Manifest-Artefakte werden zuerst in den aktiven Zustand zurückgeführt, danach wird die Execution abgebrochen.
- `PURGE_ARTIFACTS_AND_COMPLETE`: Snapshot enthält bereits `DB_COMMITTED` am oder vor dem Backup-Cutoff; verbleibende Quarantäne wird zuerst gepurgt, danach wird die Execution `COMPLETED`.
- `PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE`: post-backup COMMITTED ist signiert belegt und bereits in die private Restore-DB replayed; verbleibende Artifacts werden gepurgt und anschließend immutable Restore-Normalisierungsevidenz geschrieben. Die historische PREPARING-/ARTIFACTS_STAGED-Zeile wird nicht um erfundene Lifecycle-Zeitstempel ergänzt.

## Recovery Plan v1

Ein Plan entsteht ausschließlich aus einem unblocked `RECOVERY_READY` Assessment. `NOT_REQUIRED` und `BLOCKED` erzeugen keinen mutierbaren Plan.

Der Plan bindet unter anderem:

- Backup-Cutoff und Reconciliation-Status,
- Ledger-Generation und Ledger-Entries-Fingerprint,
- Journal-Markerzahl,
- Fingerprint der signierten Replay-Obligations,
- Assessment-Version und Assessment-Fingerprint,
- jede Recovery-Action,
- jede immutable Execution-Artifact-Referenz,
- deren erwarteten Ausgangszustand `ACTIVE`, `QUARANTINED` oder `ABSENT`,
- Actions-Fingerprint und Plan-Fingerprint.

`recovery-plan.json` enthält bewusst keinen Laufzeitstempel. Identische Eingangsevidenz erzeugt byte-identischen Inhalt. Die Datei wird exklusiv angelegt (`0600`) und der Workspace bleibt `0700`.

### Warum nach einem Crash nicht neu geplant werden darf

Wenn ein Executor bereits einen Teil der Dateien verschoben oder gelöscht hat, sieht ein erneutes Assessment einen anderen Filesystem-Zustand. Daraus erneut eine Recovery-Richtung abzuleiten wäre eine neue Entscheidung auf Basis eines bereits mutierten Systems.

Deshalb gilt:

> Sobald `recovery-plan.json` existiert, darf derselbe Workspace nicht erneut klassifiziert oder neu geplant werden.

Ein Retry muss ausschließlich den bestehenden Plan gegen die aktuelle signierte Reconciliation verifizieren und diesen Plan fortsetzen. Ändert sich die externe Evidenz so, dass der Plan nicht mehr passt, blockiert der Executor fail-closed; er erzeugt keinen Ersatzplan.

## Signed Recovery Intent v1

Vor der ersten Recovery-Mutation wird im privaten Workspace `recovery-execution/recovery-execution-pending.json` angelegt.

Der PENDING-Intent bindet:

- Backup-Cutoff,
- Plan-Version,
- Plan-Fingerprint,
- Actions-Fingerprint,
- Action-Anzahl,
- einen einmaligen `startedAt`,
- `promotionAllowed=false`.

Der Record wird HMAC-SHA256-signiert. Dafür wird ein **vierter unabhängiger 32-Byte-Key** verwendet:

```text
RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE=/etc/master-diagnostics/restore-private-recovery-intent.key
```

Erzeugung beispielsweise mit:

```bash
openssl rand -base64 32
```

Der Key darf nicht mit Backup-, Restore-Ledger- oder Privacy-Effect-Journal-Key identisch sein.

Persistenzregeln:

- Intent-Verzeichnis `0700`,
- Datei `0600`,
- exklusives Anlegen,
- identischer Retry reused den vorhandenen signierten Intent,
- ein abweichender Intent kann den bestehenden nicht ersetzen,
- der ursprünglich signierte `startedAt` bleibt über Crash/Retry stabil.

Normale Abort-/Completion-Transitions verwenden genau diesen signierten Recovery-Zeitpunkt. Dadurch werden bei einem Retry keine neuen historischen Zeitpunkte erfunden.

## Recovery Executor

`pnpm --filter @masters/db backup:restore-recovery-execute` führt keine Planung aus.

Der CLI benötigt ausschließlich bereits persistierte/verifizierbare Eingaben:

- `RESTORE_STAGING_MANIFEST`,
- Restore Privacy Ledger + Key,
- Privacy Effect Journal + Key,
- `RESTORE_PRIVATE_RECOVERY_PLAN_FILE`,
- `RESTORE_PRIVATE_RECOVERY_INTENT_DIR`,
- `RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE`,
- die drei privaten Artifact-Roots,
- die private Restore-DB über `DATABASE_URL`.

Ablauf:

1. Backup-Cutoff aus dem Staging-Manifest validieren.
2. Ledger + Journal erneut kryptografisch reconciliieren.
3. Persistierten Recovery Plan einlesen und gegen diese aktuelle Reconciliation verifizieren.
4. Vor der ersten Mutation einen signierten PENDING-Intent erzeugen oder den bereits vorhandenen verifizieren/reusen.
5. Den Plan progress-aware ausführen.
6. Technisches Resultat ausgeben; `promotionAllowed=false` bleibt unverändert.

Das Resultat weist zusätzlich aus, ob der Intent neu angelegt (`intentCreated`) oder reused (`intentReused`) wurde.

### Mutationsreihenfolge

Rollback-Richtung:

```text
RESTORE_ARTIFACTS_AND_ABORT
  Artifact Restore
  -> DB Abort
```

Forward-Richtung:

```text
PURGE_ARTIFACTS_AND_COMPLETE
  Artifact Purge
  -> DB Completion
```

```text
PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE
  Artifact Purge
  -> immutable Restore-Normalisierung
```

Der Executor ist progress-aware. Bereits ausgeführte Dateioperationen und terminale DB-/Normalization-Evidenz werden beim Retry erkannt. Unklare Zustände werden nicht heuristisch repariert.

Normale DB-Terminaltransitionen und technische Audit-Events werden in derselben DB-Transaktion geschrieben. Es wird kein Benutzer erfunden; Recovery-Ereignisse verwenden den technischen Restore-Kontext.

## Isoliertes Compose-Wiring

Der Recovery-Executor liegt bewusst in einem separaten Override:

```text
infra/docker-compose.restore-recovery.yml
```

Der Host-Workflow kombiniert:

```bash
docker compose \
  -f infra/docker-compose.club.yml \
  -f infra/docker-compose.restore-recovery.yml
```

Der Service `backup-restore-recovery-execute` erhält:

- private Restore-libSQL-DB über `backup-privacy-replay-db`,
- Staging, Ledger, Journal und alle Evidence-Keys read-only,
- den separaten Recovery-Intent-Key read-only,
- `recovery-plan.json` separat read-only,
- ausschließlich `recovery-execution`, `reports`, `tenant-exports` und `data-subject-delivery` aus dem privaten Workspace schreibbar,
- ausschließlich `restore-internal` als Netzwerk.

Damit kann der Executor weder den persistierten Plan noch andere Replay-Evidence-Dateien im Workspace überschreiben. Nicht gemountet werden produktive Targets wie `/var/lib/sqld`, produktive Reports/Exports/Delivery-Packages oder Caddy-Daten.

Der Executor-Service hängt ausschließlich von der privaten `backup-privacy-replay-db` mit erfolgreichem Healthcheck ab. Er hat absichtlich **keine Abhängigkeit zum Recovery-Planer**. Ein Compose-Retry darf den Planer nicht implizit erneut starten.

## Host-Workflow und Crash-Retry

`infra/backup/replay-club-restore-privacy-db.sh` unterscheidet zwei Wege.

Vor einer Recovery-Ausführung werden zusätzlich der Planpfad und das Intent-Verzeichnis gegen Symlink-/Dateityp-Verwechslungen geschützt. Das Intent-Verzeichnis wird mit `0700` vorbereitet; der Plan selbst bleibt read-only.

### Neuer Restore ohne bestehenden Plan

```text
private workspace copy
  -> migrate private DB
  -> artifact replay plan
  -> DB replay
  -> artifact replay
  -> recovery plan
     -> kein Plan: read-only healthcheck
     -> Plan: recovery executor -> read-only healthcheck
```

### Retry mit bereits vorhandenem `recovery-plan.json`

```text
existing private workspace
  -> migrate private DB
  -> existing plan + existing/new signed intent
  -> recovery executor resume
  -> read-only healthcheck
```

Im Retry-Pfad werden Artifact-Replay-Planung und Recovery-Planung bewusst übersprungen. Das verhindert eine Neuentscheidung auf einem teilweise veränderten Workspace.

Der frühere Zwischenstatus „Plan vorhanden, Exit 4, keine Mutation implementiert“ entfällt. Ein vorhandener Plan wird jetzt ausgeführt. Technische oder kryptografische Fehler bleiben fail-closed.

Der Recovery-Intent-Key wird nur benötigt, wenn tatsächlich ein Recovery-Plan ausgeführt werden muss. Ein bereits gesunder Restore ohne Plan benötigt diesen zusätzlichen Secret-Mount nicht zur Laufzeit.

## Post-Recovery Healthcheck

Nach jeder Recovery-Ausführung muss `backup-restore-healthcheck` erneut erfolgreich laufen.

Der Healthcheck prüft weiterhin read-only:

- aktuelle Reconciliation,
- DB-Replay-Zustand,
- Artifact-Replay-Evidenz,
- aktive Filesystem-/DB-Konsistenz,
- leere Quarantänen,
- ungelöste Transient-Executions.

Für den speziellen post-backup Forward-Fall akzeptiert er nur eine immutable Restore-Normalisierung, die erneut exakt an aktuelle Reconciliation, Backup-Cutoff, Execution/Tenant/Athlete und `dbCommittedAt` gebunden ist. Eine fremde oder alte Normalisierung bleibt blockierend.

Ein grüner Healthcheck bedeutet lediglich:

```text
readyForPromotionReview = true
promotionAllowed = false
```

## Aktuelle Scope-Grenze

Damit umfasst Epic 12 nun:

- read-only Recovery Assessment,
- durable Recovery Plan,
- signierten crash-stabilen Recovery Intent,
- mutierenden progress-aware Recovery Executor,
- isoliertes CLI-/Compose-/Host-Wiring,
- verpflichtenden Post-Recovery-Healthcheck.

Noch offen bleiben:

1. kontrolliertes Promotion-Gate mit expliziter Evidence-Bindung,
2. Restore-/Promotion-Audit,
3. praktischer Restore-/RTO-Drill.

Bis diese Schritte abgeschlossen und praktisch verifiziert sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
