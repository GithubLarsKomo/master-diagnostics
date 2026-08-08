# Private Restore Recovery Execution Intent

## Zweck

Der durable Recovery Plan legt fest, **was** auf der privaten Restore-Kopie sicher ausgeführt werden darf. Vor der ersten mutierenden Recovery-Aktion muss zusätzlich einmalig feststehen, **welcher konkrete Recovery-Lauf** diesen Plan ausführt und welcher technische Zeitpunkt für alle retrybaren Recovery-Übergänge verwendet wird.

Ohne diese zusätzliche Bindung würde ein Crash nach einer Teilmutation dazu führen, dass ein Retry einen neuen Laufzeitpunkt erzeugt. DB-Übergänge, spätere Completion-Evidenz und Audit könnten dann nicht mehr eindeutig demselben Recovery-Versuch zugeordnet werden.

Der `RestorePrivateRecoveryIntent v1` schließt diese Lücke. Er ist selbst noch nicht mutierend.

## PENDING-Vertrag

Vor der ersten Recovery-Mutation wird genau ein signierter `PENDING`-Intent erzeugt. Er bindet ausschließlich technische Daten:

- `intentVersion = 1`,
- `phase = PENDING`,
- kanonisches UTC-`startedAt`,
- Backup-Cutoff,
- Recovery-Plan-Version,
- vollständigen `planFingerprint`,
- `actionsFingerprint`,
- Action-Anzahl,
- `promotionAllowed = false`.

`startedAt` darf weder vor dem Backup-Cutoff noch vor der verwendeten signierten Ledger-Evidenz liegen.

## Signatur und Persistenz

Der Intent verwendet HMAC-SHA256 mit eigener Domain Separation:

```text
masters:restore-private-recovery-intent:v1
```

Der Signaturschlüssel wird dem Service explizit als Key-Datei übergeben. Das operative Wiring und die konkrete Secret-Provisionierung folgen erst zusammen mit dem Recovery-Executor.

Persistiert wird ein einzelner Slot:

```text
recovery-execution-pending.json
```

Eigenschaften:

- Zielverzeichnis `0700`,
- Datei `0600`,
- temporäre Datei plus atomarer Hardlink in den finalen Slot,
- identischer Inhalt ist idempotent,
- abweichender Inhalt kann den vorhandenen Intent nicht ersetzen,
- Reader verändert beim Verifizieren keine Dateirechte.

## Retry-Semantik

`ensureSignedRestorePrivateRecoveryIntent()` prüft bei jedem Aufruf zuerst, ob bereits ein gültiger Intent existiert.

Wenn ja:

- Signatur wird geprüft,
- der Intent muss exakt zum aktuell kryptografisch verifizierten Recovery Plan und dessen Reconciliation-Evidenz passen,
- das ursprüngliche `startedAt` wird unverändert wiederverwendet,
- ein neuer vom Aufrufer gelieferter Zeitpunkt wird ignoriert.

Wenn noch kein Intent existiert, wird genau einer angelegt. Parallele Erzeuger für denselben Plan konvergieren auf den ersten erfolgreich persistierten gültigen Intent.

Damit gilt nach Beginn einer Recovery:

```text
Recovery Plan     = unveränderliche Entscheidung
PENDING Intent    = unveränderlicher Recovery-Lauf + stabiler Recovery-Zeitpunkt
Executor Retry    = Fortsetzung derselben Autorisierung, keine Neuplanung
```

## Fail-closed-Regeln

Der Intent wird abgewiesen, wenn unter anderem:

- Plan oder Reconciliation nicht mehr verifiziert werden können,
- Plan-/Action-Fingerprint oder Action-Anzahl nicht passen,
- Zeitstempel nicht kanonisch sind,
- `startedAt` vor Backup-Cutoff oder Ledger-Evidenz liegt,
- Signatur fehlt, formal ungültig ist oder kryptografisch nicht stimmt,
- der persistierte Intent zu einem anderen Plan gehört.

Ein vorhandener Intent darf nicht stillschweigend überschrieben oder auf einen neuen Recovery-Zeitpunkt umgestellt werden.

## Scope-Grenze

Dieser Vertrag erzeugt nur die signierte PENDING-Autorisierung. Er führt noch keine DB- oder Dateimutation aus und erlaubt keine Promotion.

Nächste Schritte:

1. Recovery-Executor liest ausschließlich einen bereits persistierten und verifizierten Plan plus PENDING-Intent.
2. Der Executor muss Teilfortschritte idempotent erkennen und fortsetzen können.
3. Historische post-backup-COMMITTED-Zustände dürfen nicht durch erfundene Lifecycle-Zeitstempel normalisiert werden; dafür ist eine restore-spezifische technische Completion-Evidenz vorzusehen.
4. Nach erfolgreicher Recovery folgt erneut der unabhängige read-only Healthcheck.
5. Promotion bleibt bis zu einem separaten Gate gesperrt.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt unverändert.
