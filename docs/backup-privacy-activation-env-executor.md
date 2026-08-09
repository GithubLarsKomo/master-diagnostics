# Backup Privacy Activation Env Executor v1

## Zweck

Diese Schicht führt erstmals die fünf durch Activation Plan v2 autorisierten Backup-Privacy-Änderungen **atomar an der gebundenen Club-`.env`** aus. Docker-/Compose-Dienste werden weiterhin nicht neu gestartet; eine tatsächliche Runtime-Aktivierung ist damit noch nicht abgeschlossen.

Sie baut zwingend auf der signierten Execution-PENDING-Evidence auf und akzeptiert keine nachträgliche Autorisierung eines unbekannten Zustands.

## Target-Apply

`apply-target` ist nur erlaubt, wenn die Execution-Evidence `READY_TO_APPLY` meldet und die `.env` unmittelbar vor dem Replace noch exakt dem signierten `currentEnvFingerprint` entspricht.

Der Executor:

1. verifiziert Plan v2 und Execution-Evidence,
2. rekonstruiert die Target-Bytes mit demselben Plan-v2-Algorithmus,
3. verifiziert Target-Fingerprint und Rollback-Descriptor erneut,
4. schreibt eine temporäre Datei im selben Verzeichnis,
5. erhält Mode sowie Owner/Group,
6. `fsync()`t die temporäre Datei,
7. prüft den Pre-Fingerprint unmittelbar vor dem Replace erneut,
8. ersetzt die `.env` mit `os.replace()`,
9. `fsync()`t das Verzeichnis,
10. verifiziert Metadaten und Target-Fingerprint,
11. verlangt anschließend `READY_TO_VALIDATE` von der bestehenden Execution-Evidence.

Ein Retry nach einem Crash hinter dem Replace erkennt den bereits vorhandenen Target-Fingerprint und liefert `TARGET_ALREADY_APPLIED`, ohne erneut zu schreiben.

## Rollback muss vorab autorisiert werden

Der ursprüngliche Pre-Fingerprint ist sowohl der Zustand vor jeder Aktivierung als auch der Zustand nach einem erfolgreichen Rollback. Deshalb wäre ein bloßer Fingerprint nach einem Crash nicht ausreichend, um festzustellen, ob ein Rollback tatsächlich begonnen hatte.

Vor jeder Rückmutation ist daher ein separates signiertes Artefakt Pflicht:

```text
activation-env-rollback-pending.json
```

Signing Domain:

```text
masters:backup-privacy-activation-env-rollback:v1
```

Das Artefakt bindet:

- `activationId`,
- Execution-ID und Execution-Fingerprint,
- Plan-Fingerprint und Plan-HMAC,
- `.env`-Pfad,
- Target- und Rollback-Fingerprint,
- Rollback-Strategie,
- einen expliziten Reason Code,
- `rollbackMutationStarted=false`,
- `activationExecuted=false`.

Neue Rollback-Intents dürfen nur im exakten Target-Zustand erstellt werden. Ein bestehendes identisches Intent kann nach einem Crash wiederverwendet werden.

Erlaubte Reason Codes in v1:

- `POST_WRITE_RUNTIME_ATTESTATION_FAILED`
- `RUNTIME_RESTART_FAILED`
- `OPERATOR_ABORT_BEFORE_RUNTIME_ACTIVATION`

## Byte-genauer Rollback

`apply-rollback` verlangt das verifizierte Rollback-Intent. Aus dem signierten `rollbackDescriptor` werden exakt die ursprünglichen fünf Zeilen wiederhergestellt bzw. zuvor angehängte Target-Zeilen entfernt.

Der Executor verifiziert die Rekonstruktion **vor** dem Replace gegen `currentEnvFingerprint`. Auch der Rollback verwendet denselben atomaren Tempfile-`fsync`-`os.replace`-`fsync(dir)`-Pfad.

Ein Retry nach einem Crash hinter dem Rückreplace ist nur zulässig, wenn das signierte Rollback-Intent bereits vorhanden ist. Dann liefert der Executor `ROLLBACK_ALREADY_APPLIED`, statt die ursprüngliche `.env` fälschlich als „Aktivierung nie begonnen“ zu interpretieren.

## CLI

Target anwenden:

```bash
python3 infra/backup/apply-backup-privacy-activation-env.py apply-target \
  --planner /abs/prepare-backup-privacy-activation-plan.py \
  --plan-checker /abs/check-backup-privacy-activation-plan.py \
  --execution-checker /abs/backup-privacy-activation-execution.py \
  --plan /abs/activation-....json \
  --key-file /abs/backup-privacy.key \
  --env-file /abs/.env \
  --execution /abs/<activationId>/activation-execution-pending.json
```

Rollback vorautorisieren:

```bash
python3 infra/backup/apply-backup-privacy-activation-env.py prepare-rollback ... \
  --reason-code POST_WRITE_RUNTIME_ATTESTATION_FAILED
```

Rollback ausführen:

```bash
python3 infra/backup/apply-backup-privacy-activation-env.py apply-rollback ...
```

## Fail-closed-Grenzen

Der Executor blockiert insbesondere bei:

- ungültigem oder nicht reversiblen Plan,
- ungültiger Execution-Evidence,
- abweichendem `.env`-Pfad,
- Env-Drift außerhalb der beiden signierten Fingerprints,
- Target-Reapply nachdem ein Rollback-Intent existiert,
- Rollback ohne vorheriges signiertes Rollback-Intent,
- nicht reproduzierbarem Target oder Rollback,
- TOCTOU-Änderung unmittelbar vor `os.replace`,
- unsicheren Symlinks/Rechten,
- nicht erhaltbarer Dateieigentümerschaft.

## Scope-Grenze

Dieser Slice:

- ändert ausschließlich die plan-gebundene `.env`,
- verwendet keine Docker-/Compose-Kommandos,
- startet keine Dienste neu,
- behauptet keine erfolgreiche Runtime-Aktivierung,
- setzt `activationExecuted` nie auf `true`.

Nach Target-Apply bleibt zwingend eine Post-Write-Runtime-Attestation offen. Erst ein späterer Slice darf die laufenden Services kontrolliert mit dem neuen Env-Zustand neu erzeugen, die reale Capability attestieren und terminale signierte Activation-Evidence erzeugen. Bei jedem Fehler muss der hier definierte Rollback-Pfad genutzt werden.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt in der realen Installation bis zu dieser späteren kontrollierten Runtime-Aktivierung unverändert.
