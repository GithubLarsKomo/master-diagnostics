# Restore Privacy Effect Journal

## Zweck

Der signierte Restore-Privacy-Ledger kann einen geplanten Restore aus der noch verfügbaren Live-Datenbank ableiten. Für einen ungeplanten Totalausfall reicht das allein nicht: privacy-effektive Änderungen nach dem letzten Backup dürfen nicht nur in der Datenbank existieren, die gerade verloren gegangen sein kann.

Der **Privacy Effect Journal v1** ist deshalb die vorgelagerte, außerhalb der Backup-Historie persistierte Recovery-Quelle für irreversible Athletenanonymisierungen.

## Zustandsvertrag

Für eine Execution gibt es exakt zwei immutable, HMAC-signierte Slots:

1. `pending.json` enthält ausschließlich einen `PENDING`-Record und muss vor Beginn der privacy-effektiven DB-Transaktion durabel existieren.
2. `terminal.json` enthält anschließend **entweder** `COMMITTED` **oder** `ABORTED`.

`COMMITTED` bindet den tatsächlichen `dbCommittedAt`. `ABORTED` beendet ein zuvor persistiertes Intent ohne wirksamen DB-Commit.

Der Terminal-Slot ist absichtlich gemeinsam: konkurrierende Commit-/Abort-Pfade können dadurch nicht beide als gültiger Endzustand persistiert werden. Ein Terminalmarker ist nur zulässig, wenn zuvor ein verifizierter `PENDING`-Marker mit exakt derselben technischen Reconciliation-Identität existiert. Byteidentische Retries sind idempotent; jeder konkurrierende Inhalt für denselben Slot scheitert fail-closed.

Ein `PENDING` ohne verifizierbaren Terminalmarker ist absichtlich **kein** „nicht passiert“. Bei einem Restore muss dieser Zustand später die Promotion blockieren, bis er konservativ aufgelöst wurde.

## Minimierte Daten

Der Journalvertrag enthält nur die technischen Reconciliation-Bindungen, die bereits im kanonischen Restore-Privacy-Ledger verwendet werden:

- Tenant-, Athlete-, Execution-, Approval- und Deletion-Request-ID,
- Execution- und Policy-Version,
- Scope- und Capability-Fingerprint,
- Phase und Journalzeitpunkt,
- bei `COMMITTED` zusätzlich `dbCommittedAt`.

Namen, Geburtsdaten, Kontakte, Gründe, Messwerte und andere direkte Fachdaten gehören nicht in diesen Journalvertrag.

## Integrität und Persistenz

- Envelope-Version 1
- HMAC-SHA256 mit expliziter Domain-Separation
- 32-Byte Base64-Schlüssel
- Storage-Root `0700`, Marker `0600`
- Installation per Hard-Link aus einer privaten temporären Datei auf demselben Filesystem
- timing-safe Signaturprüfung
- Dateiname wird gegen Execution-ID und signierten Slot geprüft
- Terminalmarker muss kryptografisch auf dasselbe technische Intent wie `PENDING` verweisen

## Orchestrator-Integration

Der Anonymisierungs-Orchestrator erzwingt nun die Reihenfolge:

`ARTIFACTS_STAGED -> PENDING durabel -> DB-Commit -> DB_COMMITTED -> COMMITTED durabel -> Artifact-Purge -> COMPLETED`

Die technische Journalidentität wird DB-seitig aus Execution und immutable Approval geladen und ist strikt an Tenant, Athlete und Approval gebunden. Für idempotente Crash-Retries verwendet `PENDING` den bereits durablen `artifactsStagedAt`-Zeitanker und `COMMITTED` exakt den tatsächlichen `dbCommittedAt`-Zeitanker.

Wichtige Fehlergrenzen:

- Scheitert das Schreiben von `PENDING`, bleibt die Execution in `ARTIFACTS_STAGED` und die Artefakt-Quarantäne unangetastet. Es findet kein DB-Commit statt; derselbe Lauf ist nach Behebung des Journalfehlers retrybar.
- Scheitert der DB-Commit nach einem bestätigten `PENDING`, werden die Artefakte restauriert, die Execution wird `ABORTED` und anschließend wird der terminale `ABORTED`-Marker persistiert.
- Scheitert das Schreiben von `COMMITTED` nach bereits erfolgreichem DB-Commit, bleibt die Execution `DB_COMMITTED`. Der Artifact-Purge und `COMPLETED` sind gesperrt, bis der `COMMITTED`-Marker erfolgreich und kryptografisch konsistent persistiert werden kann.
- Ein Purge-Fehler nach vorhandenem `COMMITTED` bleibt wie bisher anhand des immutable Execution-Manifests retrybar; der DB-Commit wird nicht wiederholt.

Damit kann ein Journalfehler nach einer privacy-effektiven DB-Mutation niemals zu einem Artefakt-Restore oder zu einer falschen Behauptung eines Rollbacks führen.

## Club-Deployment

Der App-Container schreibt das Journal direkt auf einen separaten Host-Pfad und liest einen ausschließlich dafür vorgesehenen HMAC-Key:

- Host-Verzeichnis: `RESTORE_PRIVACY_EFFECT_JOURNAL_HOST_DIR`
- Host-Key-Datei: `RESTORE_PRIVACY_EFFECT_JOURNAL_KEY_FILE`
- Container-Verzeichnis: `RESTORE_PRIVACY_EFFECT_JOURNAL_DIR=/var/lib/masters/restore-privacy-effect-journal`
- Container-Key: `RESTORE_PRIVACY_EFFECT_JOURNAL_KEY_FILE=/run/secrets/restore-privacy-effect-journal.key`

Der Runner arbeitet als UID/GID `1001`. Vor dem ersten produktiven Start müssen Journalverzeichnis und Key deshalb für diesen Benutzer les-/schreibbar vorbereitet werden. Beispiel auf dem Host:

```sh
sudo install -d -m 0700 -o 1001 -g 1001 /var/lib/master-diagnostics/restore-privacy-effect-journal
sudo sh -c 'openssl rand -base64 32 > /etc/master-diagnostics/restore-privacy-effect-journal.key'
sudo chown 1001:1001 /etc/master-diagnostics/restore-privacy-effect-journal.key
sudo chmod 0400 /etc/master-diagnostics/restore-privacy-effect-journal.key
```

Der Journal-Key ist unabhängig vom Backup-Verschlüsselungskey und vom Restore-Privacy-Ledger-Key zu halten.

## Verbleibende Scope-Grenze

Die Writer-Seite der Disaster-Recovery-Lücke ist damit geschlossen. Offen ist weiterhin die Restore-Seite: Ein Restore-Staging muss den signierten Ledger und alle Privacy-Effect-Marker seit dem Backup-Cutoff auswerten, offene `PENDING`-Intents fail-closed behandeln und die wirksamen Anonymisierungen vor einer Promotion auf das Staging anwenden bzw. nachweisen.

Bis diese Restore-Auswertung, Healthchecks, kontrollierte Promotion und ein praktischer RTO-Drill abgeschlossen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
