# Restore / RTO Drill v1

## Zweck

Der Restore-/RTO-Drill ist der erste einzelne Host-Befehl, der die bereits separat gehärteten Epic-12-Bausteine in der realen operativen Reihenfolge ausführt und ihre Laufzeit misst.

Er ersetzt **keinen** fachlichen Freigabeprozess und aktiviert die Backup-Privacy-Capability nicht automatisch. Insbesondere bleibt bis zu einem tatsächlich auf dem vorgesehenen Club-Host erfolgreich ausgeführten und geprüften Drill:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

Ein grüner CI-Contract beweist nur, dass der Drill-Harness deterministisch orchestriert, signierte technische Reports erzeugt und seine Sicherheitsgrenzen einhält. Er ist kein Nachweis eines realen RTO auf der Zielhardware.

## RTO-Ziel

SPEC §40 setzt das technische Ziel auf vier Stunden:

```text
RTO target = 14,400 seconds
```

Die Messung beginnt unmittelbar vor der Backup-Verifikation und endet erst mit einem terminalen Ergebnis des bounded Promotion-Switch-Executors.

## Operative Reihenfolge

Der Host-Befehl führt exakt diese Phasen aus:

1. `VERIFY_BACKUP` – verschlüsseltes Bundle und Sidecar vollständig verifizieren.
2. `STAGE_RESTORE` – verifiziertes Bundle außerhalb der Produktivvolumes entschlüsselt stagen.
3. `PRIVACY_REPLAY` – private Replay-Kopie, Privacy-Reconciliation, DB-/Artifact-Replay, gegebenenfalls Recovery und finalen Healthcheck ausführen.
4. `AUTHORIZE_PROMOTION` – aktuelle private Restore-Evidence erneut bewerten und den signierten Promotion Intent erzeugen.
5. `PREPARE_PROMOTION_PLAN` – unmittelbar aktuelle Promotion-Ausführungsplanung erzeugen.
6. `PREPARE_CANDIDATES` – versionierte Candidate-Volumes erzeugen und aus der privaten Restore-Kopie befüllen.
7. `AUTHORIZE_SWITCH` – Candidate-Set erneut prüfen und einen signierten Switch Intent erzeugen.
8. `EXECUTE_SWITCH` – #219 bounded Cutover ausführen; vor der ersten Mutation wird dort nochmals die frische Candidate-/Journal-Kette geprüft. Candidate-Erfolg benötigt Post-Switch-Healthcheck und signierten Completion Receipt. Fehler konvergieren in den journalgebundenen Rollback-Pfad.

Die einzelnen Wrapper behalten ihre eigenen fail-closed Invarianten. Der Drill kopiert diese Logik nicht.

## Ausführung

Zusätzlich zu allen bereits benötigten Backup-/Restore-/Promotion-Keys wird ein sechster unabhängiger 32-Byte-Base64-HMAC-Key benötigt:

```bash
openssl rand -base64 32 | sudo tee /etc/master-diagnostics/restore-rto-drill-report.key >/dev/null
sudo chmod 600 /etc/master-diagnostics/restore-rto-drill-report.key
sudo install -d -m 700 /var/lib/master-diagnostics/restore-rto-drills
```

Konfiguration:

```dotenv
RESTORE_RTO_DRILL_REPORT_HOST_DIR=/var/lib/master-diagnostics/restore-rto-drills
RESTORE_RTO_DRILL_REPORT_KEY_FILE=/etc/master-diagnostics/restore-rto-drill-report.key
```

Dann mit einem tatsächlich vorhandenen Backup-Bundle:

```bash
bash infra/backup/run-club-restore-rto-drill.sh \
  masters-backup-<timestamp>-<uuid>.mdbak
```

Der Befehl besitzt einen eigenen hostseitigen `flock` und darf daher nicht parallel als zweiter RTO-Drill laufen.

## Achtung: reale Produktivmutation

Dies ist **kein read-only Testbefehl**. Die ersten Phasen arbeiten isoliert, aber `EXECUTE_SWITCH` verwendet den in #219 eingeführten produktiven Cutover-Executor. Bei erfolgreichem Candidate-Healthcheck wird der wiederhergestellte Candidate-Satz produktiv aktiv. Bei Fehler wird der gebundene Rollback-Satz wieder ausgewählt.

Ein realer Drill ist deshalb in einem geplanten Wartungsfenster und mit operativer Beobachtung auszuführen. Die CI ruft diesen Produktivpfad nicht gegen eine reale Club-Installation auf.

## Signierter Drill-Report

Jeder Lauf versucht auch bei Fehler einen technischen Report unter

```text
RESTORE_RTO_DRILL_REPORT_HOST_DIR/drill-<32 hex>.json
```

zu persistieren.

Sicherheitsmerkmale:

- Report-Root `0700`, Report `0600`;
- kein Fachinhalt, keine Namen, keine Diagnostikdaten, keine Logs;
- Backup nur als technischer Dateiname + SHA-256-Fingerprint;
- Staging-/Candidate-Set-ID nur als technische Identitäten;
- Phasenstatus, Dauer und Exit-Code;
- HMAC-SHA256 unter eigener Domain:

```text
masters:restore-rto-drill-report:v1
```

- eigener unabhängiger Key;
- eigener `reportFingerprint`;
- konfliktbehaftetes Wiederverwenden derselben Drill-ID wird abgelehnt.

Reportstatus:

- `COMPLETED` – der Switch-Executor endete erfolgreich mit Candidate aktiv;
- `ROLLED_BACK` – Candidate wurde nicht erfolgreich abgeschlossen und der gebundene Rollback-Pfad wurde terminal erreicht;
- `FAILED` – eine frühere Phase oder ein nicht terminal rekonstruierbarer Switch ist fehlgeschlagen.

`rtoMet=true` ist nur möglich, wenn der Gesamtstatus `COMPLETED` ist und die gemessene Dauer höchstens 14.400 Sekunden beträgt.

## Keine automatische Privacy-Aktivierung

Jeder Report enthält fest:

```text
privacyBackupActivationAllowed = false
```

Der Drill-Harness ändert weder `.env` noch Runtime-Attestation und schreibt niemals `PRIVACY_BACKUP_STATE=ENABLED`.

Das ist absichtlich eine getrennte Governance-Grenze. Erst wenn ein **realer** Drill auf der vorgesehenen Betriebsumgebung erfolgreich abgeschlossen, der signierte Report geprüft und die übrigen Epic-12-Betriebsvoraussetzungen akzeptiert wurden, darf ein späterer separater Aktivierungs-Slice erwogen werden.

## CI-Vertrag

`Restore RTO Drill Contract` verwendet eine komplett gemockte Host-Kette und prüft:

- feste Reihenfolge der acht Phasen;
- keine direkte Docker-/Volume-Mutation im Drill-Orchestrator selbst;
- `COMPLETED` erzeugt einen gültigen HMAC-Report mit `rtoMet=true` im kurzen Testlauf;
- `ROLLED_BACK` erzeugt ebenfalls einen signierten Report, aber `rtoMet=false`;
- Report- und Verzeichnisrechte;
- `privacyBackupActivationAllowed=false`;
- `TASKS.md` und Release-Gate bleiben offen;
- `.env.example` bleibt bei `PRIVACY_BACKUP_STATE=DISABLED`.

Damit ist nach Merge des Harness **noch nicht** behauptet, dass der praktische Restore-/RTO-Test durchgeführt wurde. Genau dieser reale Lauf ist der danach verbleibende operative Nachweis.
