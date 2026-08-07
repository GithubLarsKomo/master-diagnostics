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

## Aktuelle Scope-Grenze

Dieser Slice definiert und testet zunächst nur den append-only Storage-/Signaturvertrag. Er ist noch nicht in den Anonymisierungs-Orchestrator verdrahtet.

Der nächste Slice muss den Writer exakt so kapseln:

`ARTIFACTS_STAGED -> PENDING durabel -> DB-Commit -> COMMITTED durabel -> Artifact-Purge/COMPLETED`

Scheitert der DB-Commit nach `PENDING`, muss `ABORTED` durabel in den Terminal-Slot geschrieben werden. Ein Fehler beim Schreiben von `COMMITTED` nach bereits erfolgreichem DB-Commit darf niemals zu einem Restore der Artefakte oder zu einer Behauptung führen, die DB-Mutation sei rückgängig gemacht worden. Stattdessen bleibt der offene `PENDING`-Zustand ein harter Restore-Blocker.

Bis Orchestrator-Integration, Restore-Auswertung und praktischer Drill abgeschlossen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
