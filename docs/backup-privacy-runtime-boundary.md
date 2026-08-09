# Backup Privacy Live Runtime Boundary

## Problem

Der bounded Env-Executor aus #226 kann die plan-gebundene Club-`.env` atomar auf den Backup-Privacy-Target-State schreiben. Sein kanonischer Runtime-Checker lief bisher jedoch nur als **neuer Policy-Check-Prozess** mit den aus der `.env` gelesenen Privacy-Werten.

Das beweist nicht, dass bereits laufende Club-Prozesse (`app`, `export-cleanup`, `retention-scan`) dieselben Werte tatsächlich übernommen haben.

Die Aussagen

```text
Target-.env ist policy-konform
```

und

```text
produktive Prozesse laufen mit Target-Environment
```

müssen deshalb strikt getrennt bleiben.

## Fail-closed kanonischer Checker

`infra/backup/check-backup-privacy-runtime.sh` bleibt für den DISABLED-Rollback-Zustand als Policy-Verifikation nutzbar.

Für

```text
PRIVACY_BACKUP_STATE=ENABLED
```

liefert er dagegen bewusst keinen Erfolg, sondern:

```json
{
  "readyForIrreversibleProcessing": false,
  "backupState": "ENABLED",
  "attestationScope": "STATIC_ENV_POLICY_ONLY",
  "blockers": ["LIVE_RUNTIME_ATTESTATION_REQUIRED"]
}
```

und einen Exit-Code ungleich `0`.

Damit kann ein normaler Produktionslauf des Env-Executors nicht allein aus gerade geschriebenen `.env`-Werten ableiten, dass die produktive Runtime bereits aktiviert ist.

## Was weiterhin erlaubt bleibt

Der synthetische #226-Executor-Contract darf einen **explizit übergebenen Test-Checker** verwenden. Dadurch bleiben die Transaktionsinvarianten des Env-Executors deterministisch testbar:

- atomarer Replace,
- Crash/Retry nach Target-Write,
- sticky Rollback,
- bytegenaue Rückkehr,
- HMAC-Tamper-Blockade.

Diese Test-Completion ist keine Behauptung über eine reale Club-Installation.

## Konsequenz für die Service-Cutover-Kette

#227 definiert bereits einen signierten, read-only Service-Cutover-Plan. Dessen aktuelle erste Version konsumiert eine terminale #226-Completion-Evidence.

Nach Einführung dieser Runtime-Grenze ist klar: **Der produktive Defaultpfad darf eine solche terminale Completion nicht vor dem echten Service-Cutover erzeugen.**

Deshalb darf die weitere Implementierung nicht versuchen, diese Grenze durch einen statischen Checker zu umgehen. Der nächste Architekturschritt muss die Übergabe explizit machen:

1. signierte, nichtterminale Evidence dafür, dass die Target-`.env` atomar geschrieben wurde,
2. Service-Cutover-Plan gegen genau diesen Handoff-Zustand,
3. signierte Live-Baseline der noch DISABLED laufenden Container,
4. bounded Recreate nur von `app`, `export-cleanup`, `retention-scan`,
5. reale Inspect-/Health-/Environment-Attestation der neu laufenden Prozesse,
6. erst dann terminal `activationExecuted=true`,
7. bei Fehlern zuerst durable Rollback-Evidence, dann bytegenaue Pre-`.env`, Recreate auf DISABLED und Live-DISABLED-Attestation.

Bis diese Kette implementiert und auf dem vorgesehenen Host praktisch nachgewiesen ist, bleibt die Release-Grenze offen.

## Sicherheitsgrenzen dieses Slices

Dieser Slice:

- schreibt keine `.env`,
- startet oder stoppt keine Container,
- liest keine Docker-Inspect-Daten,
- erzeugt keine Live-Attestation,
- verändert `.env.example` nicht,
- schließt keinen praktischen Restore-/RTO-Task.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt damit die reale freigegebene Ausgangslage.
