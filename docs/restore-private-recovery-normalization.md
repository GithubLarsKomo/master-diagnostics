# Private Restore Recovery Normalization Evidence

## Zweck

Ein Restore-Snapshot kann eine Anonymisierung noch in `PREPARING` oder `ARTIFACTS_STAGED` enthalten, obwohl dieselbe Execution **nach dem Backup** produktiv COMMITTED wurde. Die signierte Reconciliation verpflichtet den Restore dann zur Vorwärtsrichtung und die personenbezogenen DB-Daten werden durch Restore Privacy Replay erneut entfernt.

Der historische Snapshot enthält jedoch nicht zwingend die späteren Lifecycle-Zeitstempel wie `artifactsStagedAt`. Diese fehlende Historie darf beim Restore nicht erfunden werden.

`restore_private_recovery_normalizations` ergänzt deshalb einen separaten immutable technischen Terminalnachweis. Die ursprüngliche `athlete_anonymization_executions`-Zeile bleibt unverändert.

## Exakter Anwendungsfall

Normalization Evidence ist ausschließlich zulässig für:

```text
action       = PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE
effectBasis  = POST_BACKUP_COMMITTED
snapshot     = PREPARING | ARTIFACTS_STAGED
```

Normale Recovery-Fälle verwenden später weiterhin die echten erlaubten State-Transitions:

- `PREPARING -> ABORTED`,
- `ARTIFACTS_STAGED -> ABORTED`,
- `DB_COMMITTED -> COMPLETED`.

Nur der post-backup-COMMITTED-Sonderfall benötigt den separaten Nachweis.

## Tabellenbindung

Der immutable Datensatz bindet:

- Execution-, Tenant- und Athlete-ID,
- Backup-Cutoff,
- Recovery-Plan- und Action-Fingerprint,
- Signatur des PENDING Recovery Intent,
- stabilen Recovery-Startzeitpunkt,
- historischen Snapshot-Status,
- feste Recovery-Action und Effektbasis,
- den signiert belegten post-backup `sourceDbCommittedAt`,
- den tatsächlichen Normalisierungszeitpunkt.

Update und Delete sind per Trigger verboten.

## DB-Replay-Voraussetzung

Die DB akzeptiert den Nachweis nur, wenn für dieselbe Execution bereits eine passende
`restore_privacy_replay_authorizations`-Zeile mit Status `APPLIED` existiert und deren
`db_committed_at` exakt dem signierten post-backup Commit entspricht.

Damit kann ein alter Snapshot nicht allein durch einen Recovery-Plan als normalisiert gelten. Die privacy-effektive DB-Löschung muss bereits erfolgreich replayed worden sein.

## Artifact-Post-State

Vor dem Insert prüft der Service erneut alle im Recovery Plan gebundenen Artifact-Referenzen.

Für jede Referenz müssen sowohl:

- aktive Datei,
- als auch execution-spezifische Quarantäne-Datei

abwesend sein.

Symlinks, überlappende Roots, Pfad-Escape oder noch vorhandene Dateien blockieren fail-closed. Die terminale Normalisierungsevidenz kann daher nicht vor dem späteren Artifact-Purge geschrieben werden.

## Plan- und Intent-Verifikation

`recordRestorePrivateRecoveryNormalization()` akzeptiert nicht bloß vom Aufrufer übergebene IDs. Vor dem Insert werden erneut geprüft:

1. Recovery Plan gegen die aktuelle signierte Reconciliation,
2. passende post-backup COMMITTED-Obligation,
3. persistierter signierter PENDING Recovery Intent gegen denselben Plan,
4. Chronologie `normalizedAt >= recoveryStartedAt`,
5. vollständiger Artifact-Post-State.

Exakte Wiederholung desselben Inserts ist idempotent. Eine bereits vorhandene abweichende Normalisierung blockiert.

## Keine Umschreibung historischer Execution-Evidenz

Die ursprüngliche Execution bleibt zum Beispiel `ARTIFACTS_STAGED`. Das ist beabsichtigt: Dieser Status beschreibt den tatsächlichen Stand zum Backup-Cutoff.

Spätere Restore-Komponenten müssen die immutable Normalisierungsevidenz als autoritativen technischen Abschluss für genau diesen Restore-Fall berücksichtigen. Dadurch bleibt sichtbar:

```text
historischer Snapshot-Zustand
+ signierte post-backup Privacy-Evidenz
+ angewendeter DB-Replay
+ Recovery Plan
+ PENDING Intent
+ Artifact-Purge
+ immutable Restore-Normalisierung
```

statt eine scheinbar lückenlose Lifecycle-Historie zu konstruieren, die im Backup nie existierte.

## Scope-Grenze

Dieser Slice definiert Schema, Migration und terminalen Evidence-Service. Er führt selbst noch keinen Artifact-Purge oder sonstige Recovery-Mutation aus und verändert den Healthcheck noch nicht.

Nächste Schritte:

1. idempotenter Executor für die vier Recovery-Actions,
2. post-backup-COMMITTED-Pfad purgt Artefakte und schreibt danach diese Normalisierung,
3. Healthcheck erkennt nur verifizierte Normalisierungen als aufgelöste historische Transients,
4. Post-Recovery-Healthcheck,
5. separates Promotion-Gate.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt unverändert.
