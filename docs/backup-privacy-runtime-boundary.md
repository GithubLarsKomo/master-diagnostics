# Backup Privacy Live-Runtime Boundary

## Problem

Die atomare Änderung der Club-`.env` und ein erfolgreicher Policy-Check gegen diese neuen Werte beweisen noch nicht, dass die **bereits laufenden** Club-Dienste diese Werte tatsächlich verwenden.

`env_file` wird von Docker Compose beim Erzeugen eines Containers eingelesen. Ein bereits laufender Container übernimmt eine nachträgliche Änderung der Host-`.env` nicht automatisch.

Deshalb gilt strikt:

```text
.env target written
!= live runtime switched
```

Ein frischer lokaler Prozess, dem der gewünschte `PRIVACY_*`-Satz injiziert wird, ist nur ein statischer Policy-Check. Er ist kein Nachweis des tatsächlich laufenden App-/Worker-Prozesses.

## Kanonischer Checker

`infra/backup/check-backup-privacy-runtime.sh` ist bis zur Implementierung des Host-Cutovers absichtlich fail-closed:

- bei `PRIVACY_BACKUP_STATE=ENABLED` liefert er `LIVE_RUNTIME_ATTESTATION_REQUIRED` und Exit-Code ungleich 0,
- bei `PRIVACY_BACKUP_STATE=DISABLED` bleibt er für die Rollback-Policy-Verifikation nutzbar.

Für den ENABLED-Fall kennzeichnet die Ausgabe ihren Umfang explizit als:

```text
attestationScope=STATIC_ENV_POLICY_ONLY
```

Damit kann die Standardkonfiguration des bounded Env-Executors kein `COMPLETED` allein aus den gerade geschriebenen `.env`-Werten erzeugen. Der Executor rollt mit seinem bestehenden sticky `ROLLBACK_STARTED`-Pfad auf die bytegenau gebundene DISABLED-Konfiguration zurück.

## Verhältnis zum Service-Cutover-Plan

Der read-only Service-Cutover-Plan beschreibt bereits den späteren Sollpfad für `app`, `export-cleanup` und `retention-scan` sowie die zu erhaltenden `libsql`-/`caddy`-Instanzen. Dieser Plan ersetzt jedoch keine Live-Evidence. Eine env-seitige Completion, die nur aus statischen Zielwerten abgeleitet wurde, darf nicht mit einem bereits vollzogenen Service-Cutover verwechselt werden.

Die nächste mutierende Service-Schicht muss deshalb eine signierte Live-Baseline vor jeder Container-Mutation persistieren und nach Recreate die tatsächlich laufenden Prozesse attestieren.

## Test-Hook

Der Executor behält `--runtime-checker` als expliziten Integrationspunkt. Die synthetische Executor-CI verwendet dort bewusst einen simulierten Live-Checker, um `COMPLETED`, Crash-Retry und Rollback deterministisch testen zu können.

Dieser Test-Hook ist **kein** produktiver Ersatz für Live-Runtime-Evidence. Ein produktiver ENABLED-Checker muss die tatsächlich neu erzeugten/running Services beobachten und darf nicht nur die gewünschte Host-`.env` oder einen frisch gestarteten Hilfsprozess prüfen.

## Anforderungen an den nächsten Host-Cutover

Ein produktiver Live-Checker muss mindestens binden:

1. die Activation-/Execution-Identität,
2. den exakten Target-`.env`-Fingerprint,
3. die tatsächlich laufende/recreated App-Instanz,
4. die tatsächlich laufenden lang lebenden Worker, die die globale Privacy-Policy laden,
5. Health/Ready-Zustand der neu erzeugten Services,
6. den effektiven Backup-Privacy-State der laufenden Prozesse,
7. einen stabilen Runtime-/Container-Identity-Fingerprint.

Der Host-Cutover muss vor dem ersten Service-Recreate durable Evidence schreiben und bei jedem Fehler:

1. `ROLLBACK_STARTED` sticky halten,
2. die bytegenaue ursprüngliche `.env` wiederherstellen,
3. die betroffenen Services erneut mit DISABLED-Konfiguration erzeugen,
4. den **laufenden** DISABLED-State attestieren,
5. erst danach terminalen Rollback belegen.

Erst nach erfolgreichem Live-Cutover darf eine Activation-Evidence `activationExecuted=true` im Sinn einer tatsächlich aktivierten produktiven Runtime bedeuten.

## Release-Grenze

Dieser Hardening-Slice aktiviert Backup Privacy nicht. `.env.example` bleibt `PRIVACY_BACKUP_STATE=DISABLED`; die offenen praktischen Restore-/RTO- und Release-Gates bleiben unverändert.
