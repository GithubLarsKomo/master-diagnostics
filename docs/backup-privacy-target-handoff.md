# Backup Privacy Target Handoff v1

## Warum diese zusätzliche Grenze nötig ist

Ein erfolgreicher Policy-Check in einem frisch gestarteten Hilfsprozess beweist nicht, dass die bereits laufenden Club-Prozesse eine geänderte `.env` übernommen haben. Deshalb darf ein atomarer `.env`-Write auf `PRIVACY_BACKUP_STATE=ENABLED` **nicht** mehr unmittelbar zu terminalem `activationExecuted=true` führen.

Der produktive Aktivierungspfad wird deshalb in zwei Nachweise getrennt:

```text
Target-Konfiguration gültig
  !=
Live-Prozesse haben Target-Konfiguration übernommen
```

Die Target-Handoff-Evidence beweist ausschließlich den ersten Punkt.

## Trust Chain

```text
signed activation plan v2
  -> signed PENDING execution evidence
  -> atomic target .env replace
  -> static target-configuration policy check
  -> signed TARGET_HANDOFF_READY (nonterminal)
  -> service cutover plan
  -> live baseline
  -> bounded service recreate
  -> live-process attestation
  -> terminal activation completion
```

## Target Configuration Checker

`check-backup-privacy-target-config.py` führt den bestehenden Privacy-Policy-Checker gegen die übergebene Target-Environment aus, kennzeichnet das Ergebnis aber ausdrücklich als:

```text
attestationScope=TARGET_CONFIGURATION_POLICY_ONLY
liveRuntimeAttested=false
activationExecuted=false
```

Ein gültiges Target verlangt:

- `readyForIrreversibleProcessing=true`,
- `backupState=ENABLED`,
- `backupPolicyVersion=1.0.0`,
- `blockers=[]`.

Dieser Checker liest oder mutiert keine Docker-Prozesse.

Der kanonische `check-backup-privacy-runtime.sh` bleibt für `ENABLED` dagegen fail-closed und verlangt weiterhin echten Live-Prozessnachweis.

## Target-Handoff Executor

`prepare-backup-privacy-target-handoff.py` verwendet die bereits getesteten atomaren Plan-v2-Helfer aus dem Backup-Privacy-Activation-Executor, führt aber **keine** terminale Live-Aktivierung durch.

Zulässige Ausgangszustände:

- `.env == currentEnvFingerprint`: Target wird atomar geschrieben,
- `.env == targetEnvFingerprint`: Crash-/Retry nach bereits erfolgtem Replace; kein erneuter Write,
- jeder andere Fingerprint: Blockade.

Vor jeder Mutation bleiben Plan-v2-, PENDING-, Pfad-, Fingerprint-, Lock- und Rollback-Bindungen aktiv.

## Signierte Handoff-Evidence

Bei erfolgreicher Target-Konfigurationsprüfung entsteht im activation-gebundenen Evidence-Verzeichnis:

```text
activation-target-handoff.json
```

mit eigener HMAC-Domain:

```text
masters:backup-privacy-activation-target-handoff:v1
```

Gebunden werden unter anderem:

- Activation-/Execution-ID,
- Execution-/Plan-Fingerprint,
- SHA-256 der PENDING-Evidence,
- Pre-/Target-Env-Fingerprint,
- absoluter Env-Pfad,
- Pfad und SHA-256 des Target-Configuration-Checkers,
- SHA-256 seiner vollständigen JSON-Attestation,
- `handoffFingerprint`.

Die entscheidenden Zustandsflags lauten:

```text
phase=TARGET_HANDOFF_READY
envMutationApplied=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
terminal=false
```

Damit ist die Handoff-Evidence explizit **keine** Aktivierungs-Completion.

## Crash / Retry

### Crash nach Target-Write

Wenn die `.env` bereits dem signierten Target-Fingerprint entspricht, aber noch keine Handoff-Evidence existiert, wird nur die Target-Konfiguration validiert und die Evidence geschrieben. Die Target-Bytes werden nicht erneut ersetzt.

### Retry nach Handoff

Eine vorhandene gültige Handoff-Evidence wird erneut gegen Checker-Dateihash, Target-Env und aktuelle Target-Konfigurations-Attestation geprüft. Nur bei identischem Ergebnis bleibt `TARGET_HANDOFF_READY` gültig.

### Fehlgeschlagene Target-Konfiguration

Vor dem Rückschreiben entsteht durable:

```text
activation-target-handoff-rollback-started.json
```

Danach wird der Original-Bytestring ausschließlich aus dem signierten Plan-v2-`rollbackDescriptor` rekonstruiert. Nach erfolgreicher DISABLED-Policy-Verifikation entsteht:

```text
activation-target-handoff-rollback-verified.json
```

Ein Retry nach `ROLLBACK_STARTED` darf nie wieder in einen Aktivierungsversuch zurückfallen.

## Legacy-Completion ist kein Ersatz

Vor dem Live-Service-Cutover erzeugte alte

```text
activation-execution-completed.json
```

werden von der neuen Handoff-Kette ausdrücklich als Konflikt behandelt. Sie dürfen nicht als alternativer Nachweis für einen Live-Cutover verwendet werden.

## Unabhängiger Checker

`check-backup-privacy-target-handoff.py` verifiziert:

- Plan v2 und PENDING erneut,
- aktuellen Target-Env-Fingerprint,
- kanonischen Evidence-Pfad,
- HMAC und Handoff-Fingerprint,
- Checker-Pfad und Checker-Dateihash,
- nichtterminale Zustandsflags,
- Abwesenheit von Rollback-/Legacy-Completion-Konflikten,
- aktuelle Target-Konfigurations-Attestation und deren identischen SHA-256.

Nur dann gilt:

```text
TARGET_HANDOFF_VERIFIED
serviceCutoverPlanningAllowed=true
activationExecuted=false
```

## Nächster Slice

Der bestehende Service-Cutover-Plan v1 aus #227 ist noch an die alte vorzeitige Completion gebunden. Als nächstes wird er auf **Plan v2** gehoben und ausschließlich an `TARGET_HANDOFF_VERIFIED` gebunden. Erst danach wird die Live-Baseline erneut auf der korrigierten Trust Chain aufgebaut.

Die reale Installation und `.env.example` bleiben bis zum praktischen Host-Nachweis `PRIVACY_BACKUP_STATE=DISABLED`; Restore-/RTO- und Release-Gates bleiben offen.
