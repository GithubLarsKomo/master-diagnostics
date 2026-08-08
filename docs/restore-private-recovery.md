# Private Restore Recovery Assessment

## Zweck

Ein Backup kann eine Anonymisierung mitten in ihrem mehrstufigen Ablauf enthalten. Nach Reconciliation, DB-Replay, Artifact-Replay und Healthcheck können deshalb historische `PREPARING`-, `ARTIFACTS_STAGED`- oder `DB_COMMITTED`-Zeilen sowie `.anonymization-quarantine`-Dateien übrig bleiben.

Recovery Assessment v1 entscheidet ausschließlich **read-only**, welche Recovery-Richtung für jeden solchen technischen Zustand zulässig wäre. Es verändert weder DB noch Dateien, schreibt keine Journal-Marker und erlaubt keine Promotion.

## Zentrale Prioritätsregel

Die signierte post-backup Privacy-Evidenz ist autoritativer als der ältere Snapshot-Zustand.

Beispiel:

```text
Backup-Cutoff:        Execution = ARTIFACTS_STAGED
nach dem Backup:      dieselbe Execution wird produktiv DB_COMMITTED
aktuelle Evidenz:     Ledger + Journal bestätigen COMMITTED
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

## Ergebnis

Der technische Report hat genau drei Zustände:

- `NOT_REQUIRED`: Healthcheck ist bereits vollständig gesund.
- `RECOVERY_READY`: alle historischen Blocker sind eindeutig und deterministisch einer sicheren Recovery-Richtung zugeordnet.
- `BLOCKED`: mindestens ein Zustand ist nicht eindeutig oder nicht sicher recoverbar.

Die Action-Liste ist nach Execution-ID sortiert und enthält nur technische Scope-IDs, Snapshot-Status, Effektbasis, Commit-Zeitpunkt und Artifact-Zähler.

## Scope-Grenze

Dieser Slice ist ausschließlich Assessment. Noch nicht enthalten sind:

1. mutierende Ausführung der klassifizierten Recovery-Aktionen,
2. erneuter Healthcheck nach Recovery,
3. kontrolliertes Promotion-Gate,
4. Restore-Audit und praktischer RTO-Drill.

Bis diese Schritte abgeschlossen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
