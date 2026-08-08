# Private Restore Recovery Assessment und Plan

## Zweck

Ein Backup kann eine Anonymisierung mitten in ihrem mehrstufigen Ablauf enthalten. Nach Reconciliation, DB-Replay, Artifact-Replay und Healthcheck können deshalb historische `PREPARING`-, `ARTIFACTS_STAGED`- oder `DB_COMMITTED`-Zeilen sowie `.anonymization-quarantine`-Dateien übrig bleiben.

Recovery Assessment v1 entscheidet ausschließlich **read-only**, welche Recovery-Richtung für jeden solchen technischen Zustand zulässig wäre. Es verändert weder DB noch Dateien, schreibt keine Journal-Marker und erlaubt keine Promotion.

Recovery Plan v1 macht eine `RECOVERY_READY`-Entscheidung anschließend crash-retrybar. Noch bevor irgendeine Recovery-Mutation erlaubt wird, wird die Entscheidung zusammen mit den exakten immutable Artifact-Referenzen und ihrem erwarteten Ausgangszustand dauerhaft gebunden.

## Zentrale Prioritätsregel

Die signierte post-backup Privacy-Evidenz ist autoritativer als der ältere Snapshot-Zustand.

Beispiel:

```text
Backup-Cutoff:          Execution = ARTIFACTS_STAGED
nach dem Backup:        dieselbe Execution wird produktiv DB_COMMITTED
aktuelle Evidenz:       Ledger + Journal bestätigen COMMITTED
Restore-Reconciliation: post-backup Obligation für dieselbe Execution
```

In diesem Fall darf der Restore die Quarantäne **niemals** zurückrollen. Das würde bereits wirksam gelöschte personenbezogene Daten wiederherstellen. Die einzige zulässige Richtung ist vorwärts: verbleibende Quarantäne purgen und den historischen Execution-Zustand auf der privaten Kopie normalisieren.

## Recovery-Klassen

Der Assessment-Vertrag kann folgende Aktionen empfehlen:

- `ABORT_PREPARING`: alter PREPARING-Zustand, keine post-backup COMMITTED-Evidenz, alle Manifest-Artefakte noch aktiv.
- `RESTORE_ARTIFACTS_AND_ABORT`: keine COMMITTED-Evidenz; bereits quarantänierte Manifest-Artefakte müssen vor einem Abort zurück in den aktiven Zustand.
- `PURGE_ARTIFACTS_AND_COMPLETE`: Snapshot selbst enthält bereits `DB_COMMITTED` mit Commit-Zeitpunkt am oder vor dem Backup-Cutoff; nur Vorwärts-Finalisierung ist zulässig.
- `PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE`: signierte post-backup COMMITTED-Obligation wurde bereits in die private Restore-DB replayed; ein älterer PREPARING/ARTIFACTS_STAGED-Snapshot darf nur vorwärts normalisiert werden.

Alle Outputs bleiben bei `promotionAllowed: false`.

## Artifact-State-Beweis

Für jede Recovery-Execution wird das beim ursprünglichen Prepare persistierte technische Artifact-Manifest verwendet. Pro Manifest-Eintrag wird read-only geprüft, ob die Datei:

- aktiv vorhanden,
- unter `.anonymization-quarantine/<executionId>/...` vorhanden,
- oder bereits abwesend ist.

Aktiv- und Quarantäne-Datei gleichzeitig, ungültige Referenzen oder nicht reguläre Dateien blockieren fail-closed.

Erwartete Zustände:

- PREPARING ohne Commit-Evidenz: jedes Artifact muss aktiv oder quarantänisiert sein; nichts darf fehlen. Bei mindestens einem Quarantäne-Artifact wird Restore+Abort verlangt.
- ARTIFACTS_STAGED ohne Commit-Evidenz: alle Manifest-Artefakte müssen quarantänisiert sein.
- pre-cutoff DB_COMMITTED: aktive Kopien sind verboten; Quarantäne oder bereits abwesend ist zulässig.
- post-backup COMMITTED: aktive Kopien sind verboten; Quarantäne oder bereits abwesend ist zulässig.

Eine Quarantäne-Datei, die nicht exakt zum persistierten Execution-Manifest gehört, blockiert.

## Healthcheck-Bindung

Recovery Assessment akzeptiert nur einen Healthcheck, dessen Reconciliation-/DB-/Artifact-Evidenz weiterhin verifiziert ist. Nur diese Healthcheck-Blocker sind überhaupt Recovery-fähig:

- `ANONYMIZATION_EXECUTION_TRANSIENT`,
- `ANONYMIZATION_QUARANTINE_NOT_EMPTY`,
- `ACTIVE_ARTIFACT_MISSING`.

Root-/Scanfehler, Symlinks, Sonderdateien, Orphans oder kryptografische Evidence-Fehler bleiben nicht recoverbar und blockieren sofort.

## Assessment-Ergebnis

Der technische Report hat genau drei Zustände:

- `NOT_REQUIRED`: Healthcheck ist bereits vollständig gesund.
- `RECOVERY_READY`: alle historischen Blocker sind eindeutig und deterministisch einer sicheren Recovery-Richtung zugeordnet.
- `BLOCKED`: mindestens ein Zustand ist nicht eindeutig oder nicht sicher recoverbar.

Die Assessment-Action-Liste ist nach Execution-ID sortiert und enthält nur technische Scope-IDs, Snapshot-Status, Effektbasis, Commit-Zeitpunkt und Artifact-Zähler.

## Recovery Plan v1

Ein Plan darf ausschließlich aus einem unblocked `RECOVERY_READY` Assessment entstehen. `NOT_REQUIRED` und `BLOCKED` erzeugen keinen mutierbaren Recovery-Plan.

Der Plan bindet:

- Backup-Cutoff und Reconciliation-Status,
- Ledger-Generation und Ledger-Entries-Fingerprint,
- Journal-Markerzahl,
- Fingerprint aller signierten Replay-Obligations,
- Assessment-Version und deterministischen Assessment-Fingerprint,
- jede Recovery-Action,
- für jede Action alle immutable Execution-Artifact-Referenzen,
- deren erwarteten Ausgangszustand `ACTIVE`, `QUARANTINED` oder `ABSENT`,
- einen Fingerprint der vollständigen Action-Liste,
- einen Fingerprint des vollständigen Plans.

Es gibt bewusst keinen Laufzeitstempel. Identische Eingangsevidenz erzeugt byte-identischen Planinhalt.

### Warum die exakten Artifact-Referenzen notwendig sind

Nur Action-Typ und Artifact-Zähler reichen für Crash-Recovery nicht aus. Wenn ein Executor beispielsweise zwei von drei Quarantäne-Dateien bereits zurückkopiert und danach abstürzt, würde ein erneutes read-only Assessment einen anderen Filesystem-Zustand sehen. Ein Recovery-Retry darf dann nicht neu entscheiden, sondern muss den **vor der ersten Mutation persistierten Plan** fortsetzen.

Deshalb ist der Plan die Wiederanlauf-Autorisierung für den späteren Executor. Er hält exakt fest, welche immutable Referenzen betroffen waren und welchen Ausgangszustand sie beim Planen hatten.

### Pfad- und Scope-Schutz

Schon beim Planen werden die privaten Artifact-Roots erneut geprüft:

- absolute, existierende Nicht-Symlink-Verzeichnisse,
- drei getrennte, nicht überlappende Roots,
- keine absoluten Referenzen, kein `..`, keine Windows-Backslashes,
- produktive Referenzformate für Report, Tenant-Export und Betroffenenexport,
- Report-Referenzen bleiben an den Tenant gebunden,
- kein vorhandener Pfadbestandteil darf ein Symlink sein,
- vorhandene Ziele müssen reguläre Dateien sein,
- aktive und quarantänisierte Kopie derselben Referenz gleichzeitig blockieren.

### Persistenz und Retry

Der Plan wird für den privaten Restore-Workspace als `recovery-plan.json` vorgesehen:

- Parent-Verzeichnis `0700`,
- Datei `0600`,
- exklusives Erzeugen mit `wx`,
- identischer Retry ist byte-identisch und idempotent,
- ein bereits vorhandener anderer Inhalt blockiert fail-closed.

Der Reader verändert beim Verifizieren keine Dateirechte. Dadurch kann ein späterer Executor den Plan auch aus einem read-only Evidence-Mount prüfen.

Nach einer Teilmutation muss der Plan nicht gegen den inzwischen veränderten Filesystem-Zustand neu erzeugt werden. Er kann weiterhin intern und gegen die erneut kryptografisch verifizierte Restore-Reconciliation geprüft werden.

## Recovery-Plan CLI

`pnpm --filter @masters/db backup:restore-recovery-plan` führt die komplette **nicht-mutierende** Entscheidungsstrecke in einem Prozess aus:

1. Backup-Cutoff aus dem Staging-Manifest validieren,
2. Ledger + Privacy-Effect-Journal erneut kryptografisch reconciliieren,
3. Artifact-Replay-Manifest und -Result einlesen,
4. privaten Restore-Healthcheck erneut berechnen,
5. Recovery Assessment ausführen,
6. nur bei `RECOVERY_READY` den deterministischen Plan exklusiv persistieren.

Erforderliche Pfade werden ausschließlich als absolute Umgebungsvariablen akzeptiert. Zusätzlich zu den bereits für den Healthcheck verwendeten Variablen ist `RESTORE_PRIVATE_RECOVERY_PLAN_FILE` erforderlich.

Das JSON-Ergebnis verwendet `mode: ISOLATED_RESTORE_RECOVERY_PLAN` und hat drei Zustände:

- `NOT_REQUIRED`: Restore ist bereits gesund; Exit `0`, keine Plan-Datei.
- `PLAN_READY`: Recovery ist eindeutig; Exit `0`, Plan wurde neu erstellt oder byte-identisch wiederverwendet.
- `BLOCKED`: mindestens ein nicht sicher recoverbarer Zustand; Exit `3`, keine Plan-Datei.

Technische/strukturelle Fehler bleiben Exit `1`.

Der CLI darf **nur vor der ersten Recovery-Mutation** zur Neuplanung verwendet werden. Nach einem Crash mitten in einer späteren Recovery darf nicht erneut aus dem veränderten Filesystem klassifiziert werden; dann muss der Executor den bereits persistierten und gegen die aktuelle signierte Reconciliation verifizierten Plan fortsetzen.

## Isoliertes Compose-/Host-Wiring

`backup-restore-recovery-plan` läuft ausschließlich im internen Restore-Netz. Der Service erhält:

- die private Restore-libSQL-DB,
- Staging-Manifest, Ledger, Journal und beide Schlüssel nur read-only,
- Artifact-Replay-Manifest/-Result aus dem privaten Workspace,
- die drei privaten Artifact-Roots,
- `/restore-replay/recovery-plan.json` als einziges neues Evidence-Ziel.

Nur `/restore-replay` ist für diesen Service schreibbar. Es werden keine produktiven DB-, Report-, Export-, Delivery-, Caddy- oder sonstigen Produktiv-Volumes gemountet.

Der Host-Workflow `replay-club-restore-privacy-db.sh` führt nach Artifact-Replay zuerst den Recovery-Planer aus:

- `BLOCKED` aus dem Planer beendet den Ablauf mit Exit `3`.
- Wenn `recovery-plan.json` entsteht, beendet der Wrapper bewusst mit Exit `4`: Recovery ist eindeutig geplant, aber in diesem Release wird **keine** Recovery-Mutation ausgeführt.
- Wenn kein Plan erforderlich ist, folgt weiterhin der unabhängige read-only Healthcheck und muss `HEALTHY` melden.

Damit kann ein recoverbarer historischer Zwischenzustand nicht mehr bloß am roten Healthcheck enden, ohne dass seine sichere Richtung durable gebunden wird; gleichzeitig kann der aktuelle Release noch keinen geplanten Zustand automatisch verändern oder als erfolgreichen Restore ausgeben.

## Scope-Grenze

Der aktuelle Stand umfasst Assessment, durable Recovery-Plan, CLI und isoliertes Compose-/Host-Wiring. Noch nicht enthalten sind:

1. mutierende Ausführung der persistierten Recovery-Aktionen,
2. erneuter Healthcheck nach Recovery,
3. kontrolliertes Promotion-Gate,
4. Restore-Audit und praktischer RTO-Drill.

Bis diese Schritte abgeschlossen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
