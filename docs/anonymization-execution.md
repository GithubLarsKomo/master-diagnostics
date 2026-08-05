# Irreversible Anonymisierungs-Ausführung

## Zweck

Die irreversible Athletenverarbeitung darf nicht als scheinbar atomare Operation über Datenbank **und** Dateisystem modelliert werden. SQLite/libSQL-Transaktionen können externe Report-PDFs und verschlüsselte Tenant-Exportpakete nicht zurückrollen.

Deshalb verwendet die Ausführung einen expliziten, versionierten Zwei-Phasen-Vertrag:

1. Approval unmittelbar vor Beginn frisch validieren.
2. Durable Execution-Zeile im Zustand `PREPARING` verwenden.
3. Externe Artefakte atomar in eine ausführungsgebundene Quarantäne verschieben.
4. Erst wenn alle Artefakte erfolgreich staged sind, Zustand `ARTIFACTS_STAGED` setzen.
5. Sämtliche fachlichen DB-Änderungen inklusive Audit-Privacy-Redaktion in **einer** DB-Transaktion durchführen und darin den Zustand auf `DB_COMMITTED` setzen.
6. Nach dauerhaftem DB-Commit die Quarantäne endgültig löschen.
7. Erst nach erfolgreichem Purge Zustand `COMPLETED` setzen.

## Durable Execution State

`athlete_anonymization_executions` ist ein technischer, PII-armer Nachweis für genau eine gebundene Approval. Pro Approval darf höchstens eine Execution existieren.

Version: `1`.

Zulässige Zustände:

- `PREPARING`
- `ARTIFACTS_STAGED`
- `DB_COMMITTED`
- `COMPLETED`
- `ABORTED`

Zulässige Übergänge:

```text
PREPARING ────────────────> ARTIFACTS_STAGED ────────────────> DB_COMMITTED ────────────────> COMPLETED
    │                              │
    └────────────> ABORTED <───────┘
```

Nach `DB_COMMITTED` ist kein Abort mehr zulässig. Ein fehlgeschlagener finaler Purge verbleibt deshalb als retrybarer `DB_COMMITTED`-Zustand; die bereits anonymisierte Datenbank wird nicht zurückgerollt.

Die Datenbankmigration schützt Identität und Übergänge zusätzlich mit Triggern. Execution-Zeilen dürfen nicht gelöscht werden.

## Vorbereitung

`prepareAthleteAnonymizationExecution()`:

- akzeptiert ausschließlich `TENANT_ADMIN`,
- revalidiert die gebundene Approval gegen aktuellen Precheck, Scope und Runtime-Capabilities,
- erzeugt genau eine Execution pro Approval,
- mutiert keine Athleten-, Diagnostik- oder Artefaktdaten,
- schreibt ein PII-freies Audit-Ereignis `athlete.anonymization_execution_prepared`.

Die Vorbereitung ist noch **keine** Ausführungsfreigabe. Der spätere Writer muss die Approval unmittelbar vor dem ersten Quarantäne-`rename()` erneut validieren.

## Artifact Quarantine

Report- und Tenant-Export-Storage unterstützen zusätzlich:

- `stageForDeletion(executionId, reference)`
- `restoreStaged(handle)`
- `purgeStaged(handle)`

Die File-System-Implementierung verschiebt Dateien mit `rename()` innerhalb desselben Storage-Roots nach `.anonymization-quarantine/<executionId>/...`.

Eigenschaften:

- kein Laden großer Exportdateien in den Arbeitsspeicher,
- Stage ist idempotent,
- ein Artefakt darf nicht gleichzeitig aktiv und quarantänisiert existieren,
- Restore ist vor DB-Commit möglich und idempotent,
- Purge ist nach DB-Commit idempotent,
- unsichere Execution-IDs und Storage-Referenzen werden vor Pfadkonstruktion verworfen.

## Multi-Artifact-Orchestrierung

`stageAnonymizationArtifacts()` behandelt alle Report- und Tenant-Export-Referenzen als Gruppe. Scheitert ein späteres Stage, werden bereits verschobene Artefakte in umgekehrter Reihenfolge zurückgespielt. Ein unvollständiger Rollback wird als `AggregateError` sichtbar und darf nicht in einen DB-Commit übergehen.

`restoreAnonymizationArtifacts()` ist ausschließlich vor dem DB-Commit zulässig.

`purgeAnonymizationArtifacts()` ist ausschließlich nach dem DB-Commit vorgesehen. Ein Purge-Fehler ist retrybar und darf nicht durch eine erneute fachliche DB-Anonymisierung beantwortet werden.

## Noch nicht in diesem Slice

Dieser Vertrag implementiert bewusst noch nicht die fachlichen irreversiblen DB-Mutationen. Der nächste Slice muss:

- die Approval unmittelbar vor dem ersten Stage erneut validieren,
- die Preview-Referenzen unverändert als Staging-Input verwenden,
- Audit-Privacy-Redaktionen und sämtliche fachlichen Deletes/Redaktionen in eine gemeinsame DB-Transaktion integrieren,
- das minimierte Athleten-Tombstone-Profil definieren,
- Report-/Export-DB-Records erst nach erfolgreichem Staging entfernen,
- den Execution-Status innerhalb derselben DB-Transaktion auf `DB_COMMITTED` setzen,
- nach Purge ein PII-freies Abschluss-Audit schreiben.
