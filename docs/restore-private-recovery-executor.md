# Private Restore Recovery Executor

## Zweck

Der Recovery Executor ist der erste mutierende Restore-Schritt. Er arbeitet ausschließlich auf der privaten Restore-Kopie und akzeptiert keine neu berechnete Recovery-Entscheidung. Voraussetzung sind:

- ein bereits persistierter und gegen die aktuelle signierte Reconciliation verifizierter Recovery Plan,
- ein bereits persistierter und signierter PENDING Recovery Intent für genau diesen Plan,
- die privaten Restore-Artifact-Roots.

`promotionAllowed` bleibt immer `false`.

## Mutationsreihenfolge

Rollback- und Forward-Pfade verwenden bewusst unterschiedliche Reihenfolgen:

- `ABORT_PREPARING`: aktive Artefakte unverändert beweisen, dann `PREPARING -> ABORTED`.
- `RESTORE_ARTIFACTS_AND_ABORT`: geplante Quarantäne-Dateien zuerst atomar zurück in den aktiven Pfad verschieben; erst danach `PREPARING|ARTIFACTS_STAGED -> ABORTED`.
- `PURGE_ARTIFACTS_AND_COMPLETE`: aktive Kopien verbieten, geplante Quarantäne-Dateien zuerst löschen; erst danach `DB_COMMITTED -> COMPLETED`.
- `PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE`: aktive Kopien verbieten, Quarantäne zuerst löschen; danach immutable Restore-Normalisierung schreiben. Die historische `PREPARING|ARTIFACTS_STAGED`-Execution bleibt unverändert.

Damit kann ein DB-Abort nie vor einer noch nicht zurückgespielten Datei und ein Completion-/Normalization-Nachweis nie vor einem noch vorhandenen privacy-relevanten Artifact entstehen.

## Stabile Zeitbasis

Für normale DB-Terminalzustände verwendet der Executor ausschließlich `startedAt` aus dem signierten PENDING Intent:

- `abortedAt = recoveryIntent.startedAt`,
- `completedAt = recoveryIntent.startedAt`.

Ein Retry kann deshalb einen bereits angewendeten Zustand exakt erkennen. Ein anderer Zeitstempel im bereits terminalen Datensatz blockiert.

Für die restore-spezifische Normalisierung ist `normalizedAt` der tatsächliche terminale Insert-Zeitpunkt. Existiert bereits passende immutable Evidence, wird sie unabhängig von einem später vorgeschlagenen `normalizedAt` als abgeschlossene Recovery wiederverwendet.

## Artifact-Fortschritt

Der Executor interpretiert den im Plan gebundenen Ausgangszustand progress-aware:

### Restore/Abort

Ein als `QUARANTINED` geplanter Eintrag darf beim Retry entweder noch quarantänisiert oder bereits wieder aktiv sein. Beides gleichzeitig oder beides abwesend blockiert. Ein als `ACTIVE` geplanter Eintrag muss aktiv bleiben.

### Forward/Purge

Ein als `QUARANTINED` geplanter Eintrag darf noch quarantänisiert oder bereits abwesend sein. Eine aktive Kopie blockiert immer. Ein als `ABSENT` geplanter Eintrag muss weiterhin vollständig abwesend sein.

Symlinks, Pfad-Escape, überlappende Roots und nicht reguläre Dateien blockieren fail-closed.

## DB-Transitions und Audit

Normale Aborts und Completion verwenden dieselben DB-Trigger-Invarianten wie der produktive Lifecycle. Der Restore-Executor setzt keinen erfundenen Benutzer ein. Stattdessen wird innerhalb derselben DB-Transaktion ein technisches Audit-Event mit:

- `actorRole = RESTORE_RECOVERY`,
- `source = RESTORE_RECOVERY`,
- Plan-Fingerprint als Correlation-ID

geschrieben.

Dadurch bleiben State-Transition und Audit atomar.

## Idempotenz

Jede Action kann mit demselben Plan und Intent erneut ausgeführt werden:

- bereits zurückgespielte Dateien werden erkannt,
- bereits gepurgte Dateien werden erkannt,
- `ABORTED`/`COMPLETED` werden nur akzeptiert, wenn ihr Terminalzeitpunkt exakt dem signierten Recovery-Start entspricht,
- vorhandene Restore-Normalisierung muss exakt an Plan und Intent gebunden sein.

Ein abweichender oder nicht beweisbarer Zwischenzustand wird nicht heuristisch repariert.

## Scope-Grenze

Dieser Slice enthält nur Executor-Service, Tests, Export und Dokumentation. Noch nicht enthalten sind:

1. CLI und Secret-Provisionierung für den PENDING Intent,
2. Compose-/Host-Wiring des Executors,
3. Healthcheck-Unterstützung für verifizierte Restore-Normalisierungen,
4. Post-Recovery-Healthcheck,
5. Promotion-Gate und RTO-Drill.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt unverändert.
