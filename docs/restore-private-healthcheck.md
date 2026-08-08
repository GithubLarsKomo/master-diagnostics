# Private Restore Healthcheck

## Zweck

Nach erfolgreicher Restore-Privacy-Reconciliation, DB-Replay und Artifact-Replay braucht die private Restore-Kopie einen read-only Konsistenzcheck, bevor überhaupt über eine Promotion gesprochen werden darf.

Der Healthcheck verändert weder Datenbank noch Dateien und erteilt selbst keine Promotion-Freigabe. Auch ein vollständig grüner Lauf liefert daher weiterhin `promotionAllowed: false`.

## Healthcheck v1

`backup:restore-healthcheck` verbindet vier bereits vorhandene Evidenz- und Zustandsquellen:

1. die signierte Restore-Privacy-Reconciliation,
2. den aktuellen DB-Zustand der privaten Restore-Kopie,
3. das verifizierte `artifact-replay-manifest.json` plus `artifact-replay-result.json`,
4. die drei privaten Artifact-Roots `reports/`, `tenant-exports/` und `data-subject-delivery/`.

Zusätzlich kann der Healthcheck eine immutable `restore_private_recovery_normalizations`-Zeile als terminalen technischen Nachweis für genau den Sonderfall akzeptieren, in dem ein historischer `PREPARING`- oder `ARTIFACTS_STAGED`-Snapshot durch eine post-backup COMMITTED-Obligation bereits DB-seitig nachgezogen und im Recovery-Executor vollständig normalisiert wurde.

Ein gesunder Zustand benötigt gleichzeitig:

- Reconciliation ist nicht `BLOCKED`,
- DB-Assessment ist `DATABASE_SATISFIED`,
- Artifact-Manifest passt weiterhin zur signierten Reconciliation,
- Artifact-Replay-Result passt weiterhin exakt zum Manifest,
- jede aktive DB-Storage-Referenz besitzt genau eine entsprechende reguläre Datei,
- jede aktive Datei besitzt eine entsprechende DB-Storage-Referenz,
- keine Symlinks oder Sonderdateien liegen in den Artifact-Roots,
- keine nichtleeren `.anonymization-quarantine`-Bestände existieren,
- keine ungelöste Anonymisierung steht in `PREPARING`, `ARTIFACTS_STAGED` oder `DB_COMMITTED`.

## Historische Transients und Restore-Normalisierung

Ein Backup kann während einer laufenden Anonymisierung entstehen. Dann kann die private Restore-Kopie beispielsweise:

- bereits verschobene Artifact-Dateien in `.anonymization-quarantine` enthalten,
- noch unveränderte DB-Daten bei `ARTIFACTS_STAGED` enthalten,
- oder bereits DB-commitete Daten bei noch nicht abgeschlossenem Artifact-Purge (`DB_COMMITTED`).

Diese Zustände werden weiterhin niemals pauschal ignoriert. `PREPARING`, `ARTIFACTS_STAGED` und `DB_COMMITTED` erzeugen grundsätzlich `ANONYMIZATION_EXECUTION_TRANSIENT`.

Eine einzige eng definierte Ausnahme existiert nach erfolgreichem Recovery:

- Snapshot-Status ist `PREPARING` oder `ARTIFACTS_STAGED`,
- die aktuelle Reconciliation enthält für exakt dieselbe Execution eine post-backup COMMITTED-Obligation,
- die private DB enthält die bereits `APPLIED` Restore-Privacy-Replay-Autorisierung,
- der Recovery-Executor hat alle plan-gebundenen Artifact-Kopien entfernt,
- danach wurde die immutable Restore-Normalisierung geschrieben.

Der Healthcheck vertraut dabei nicht nur auf das Vorhandensein der Zeile. Die Normalisierung muss erneut exakt an den aktuellen Zustand gebunden sein:

- `executionId`, Tenant und Athlete stimmen mit der historischen Execution überein,
- `backupCutoff` entspricht der aktuell geprüften Reconciliation,
- `snapshotStatus` entspricht weiterhin der historischen Execution,
- `action = PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE`,
- `effectBasis = POST_BACKUP_COMMITTED`,
- `sourceDbCommittedAt` entspricht exakt der aktuellen Reconciliation-Obligation,
- Plan-/Actions-Fingerprints und Intent-Signatur besitzen die kanonische technische Form,
- Commit-, Recovery- und Normalisierungszeitpunkte sind kanonisch und chronologisch konsistent.

Nur dann wird die Execution aus `transientExecutions` entfernt und stattdessen technisch unter `normalizedTransientExecutions` ausgewiesen. Die historische Execution-Zeile selbst bleibt unverändert; es werden keine Lifecycle-Zeitstempel erfunden.

Eine vorhandene, aber nicht exakt passende Normalisierung blockiert fail-closed mit `RECOVERY_NORMALIZATION_INVALID` **und** weiterhin `ANONYMIZATION_EXECUTION_TRANSIENT`. Insbesondere kann eine Normalisierung aus einem anderen Backup-Cutoff keinen aktuellen Restore freigeben.

`DB_COMMITTED` besitzt keine solche Normalisierungsausnahme: dieser Zustand muss über die normale Recovery-Transition terminal `COMPLETED` werden.

## Storage-Konsistenz

Für jeden privaten Artifact-Root wird deterministisch verglichen:

- Anzahl der DB-Referenzen,
- Anzahl aktiver regulärer Dateien,
- Anzahl Quarantäne-Dateien,
- Anzahl Symlinks,
- Anzahl sonstiger Sonderdateien.

Blockiert werden unter anderem:

- `ACTIVE_ARTIFACT_MISSING`,
- `ACTIVE_ARTIFACT_ORPHANED`,
- `STORAGE_SYMLINK_PRESENT`,
- `STORAGE_SPECIAL_ENTRY_PRESENT`,
- `ANONYMIZATION_QUARANTINE_NOT_EMPTY`.

Das verhindert sowohl fehlende Report-/Export-Dateien als auch verwaiste Dateien, die nach einem Restore weiterhin sensible Inhalte tragen könnten, obwohl keine aktive DB-Metadatenzeile mehr auf sie verweist.

## Technischer Output

Der Report enthält nur technische IDs, Storage-Referenzen, Statuswerte, Fingerprints, Zeitpunkte, Zähler und Blocker-Codes. Namen, Kontakte, Löschgründe, Messwerte oder Reportinhalte werden nicht ausgegeben.

Wichtige Felder:

- `status = HEALTHY | BLOCKED`,
- `healthcheckPassed`,
- `readyForPromotionReview`,
- `promotionAllowed = false`,
- `databaseStatus`,
- `artifactManifestVerified`,
- `artifactReplayVerified`,
- Storage-Zähler,
- ungelöste `transientExecutions`,
- terminal nachgewiesene `normalizedTransientExecutions`,
- kanonisch sortierte Blocker.

Der CLI-Prozess endet bei `BLOCKED` mit einem Fehlerstatus, bleibt aber vollständig read-only.

## Isolierte Compose-Ausführung

Der Healthcheck ist als eigener `backup-restore-healthcheck`-Service im internen Netzwerk `restore-internal` verdrahtet. Er startet ausschließlich nach erfolgreich abgeschlossenem `backup-privacy-artifact-replay`.

Der operative Ablauf lautet derzeit:

```text
private workspace copy
  -> backup-privacy-replay-migrate
  -> backup-privacy-artifact-plan
  -> backup-privacy-replay
  -> backup-privacy-artifact-replay
  -> recovery planning / evidence
  -> backup-restore-healthcheck
```

Der Recovery-Executor aus dem separaten Recovery-Slice ist noch nicht in diesen operativen Compose-/Host-Ablauf eingebaut. Bis dieses Wiring vorhanden ist, kann der produktive Host-Workflow die neue Normalisierungsausnahme noch nicht automatisch erzeugen; die Healthcheck-Domainlogik ist dafür aber vorbereitet und separat getestet.

Für den Healthcheck gelten zusätzliche Schreibschutzgrenzen:

- Restore-Staging: read-only,
- Privacy Ledger: read-only,
- Privacy-Effect-Journal: read-only,
- Signing Keys: read-only,
- kompletter privater `/restore-replay`-Workspace: read-only,
- Zugriff auf die private libSQL-Kopie ausschließlich über den isolierten Restore-DB-Pfad,
- keine produktiven libSQL-, Report-, Export-, Betroffenenexport- oder Caddy-Volumes.

Auch die Manifest-/Result-Verifikation im Healthcheck selbst führt keine `chmod`-Normalisierung oder andere Evidence-Mutation aus. CI führt denselben `HEALTHY`-Check zweimal aus und verifiziert dabei identischen Output sowie unveränderte SHA-256-Hashes von `artifact-replay-manifest.json` und `artifact-replay-result.json`.

## Scope-Grenze

Dieser Slice erweitert ausschließlich den read-only Healthcheck-Vertrag um die terminale Restore-Normalisierung aus dem Recovery-Executor. Er führt selbst keine Recovery aus und verdrahtet den Executor noch nicht operativ.

Noch offen bleiben:

1. CLI-/Compose-/Host-Wiring für signierten Recovery Intent und Recovery Executor,
2. ein expliziter Post-Recovery-Healthcheck im Host-Ablauf,
3. ein kontrolliertes Promotion-Gate, das Reconciliation, DB-Replay, Artifact-Replay, Recovery-Evidenz und Healthcheck gemeinsam bindet,
4. Restore-Audit und praktischer Restore-/RTO-Drill.

Bis diese Schritte abgeschlossen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
