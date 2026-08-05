# Irreversible Anonymisierungs-Ausführung

## Zweck

Die irreversible Athletenverarbeitung darf nicht als scheinbar atomare Operation über Datenbank **und** Dateisystem modelliert werden. SQLite/libSQL-Transaktionen können externe Report-PDFs und verschlüsselte Tenant-Exportpakete nicht zurückrollen.

Deshalb verwendet die Ausführung einen expliziten, versionierten Zwei-Phasen-Vertrag:

1. Approval unmittelbar vor Beginn frisch validieren.
2. Durable Execution-Zeile im Zustand `PREPARING` samt unveränderlichem Artifact-Manifest verwenden.
3. Externe Artefakte atomar in eine ausführungsgebundene Quarantäne verschieben.
4. Erst wenn alle Artefakte erfolgreich staged sind, Zustand `ARTIFACTS_STAGED` setzen.
5. Sämtliche fachlichen DB-Änderungen inklusive Audit-Privacy-Redaktion in **einer** DB-Transaktion durchführen und darin den Zustand auf `DB_COMMITTED` setzen.
6. Nach dauerhaftem DB-Commit die Quarantäne anhand des weiterhin vorhandenen Manifests endgültig löschen.
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

## Durables Artifact-Manifest

`athlete_anonymization_execution_artifacts` hält die beim Prepare gebundenen externen Referenzen unabhängig von deren späteren fachlichen Quellzeilen fest:

- `REPORT` für Report-PDFs,
- `TENANT_EXPORT` für vollständige Tenant-Exportpakete.

Die Manifestzeilen sind immutable und nicht löschbar. Sie enthalten nur Execution-/Tenant-Bezug, Artefaktart und technische `storage_reference`.

Das Manifest ist notwendig, weil nach einem erfolgreichen fachlichen DB-Commit die ursprünglichen `report_versions`- bzw. `tenant_export_packages`-Zeilen nicht mehr als Recovery-Quelle vorausgesetzt werden dürfen. Ein Prozessabsturz zwischen `DB_COMMITTED` und finalem Purge kann dadurch nach Neustart deterministisch fortgesetzt werden.

## Vorbereitung

`prepareAthleteAnonymizationExecution()`:

- akzeptiert ausschließlich `TENANT_ADMIN`,
- revalidiert die gebundene Approval gegen aktuellen Precheck, Scope und Runtime-Capabilities,
- erzeugt genau eine Execution pro Approval,
- persistiert das zugehörige unveränderliche Artifact-Manifest in derselben DB-Transaktion,
- mutiert keine Athleten-, Diagnostik- oder Artefaktdaten,
- schreibt ein PII-freies Audit-Ereignis `athlete.anonymization_execution_prepared` mit ausschließlich technischen Zählern.

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

`purgeAnonymizationArtifacts()` ist ausschließlich nach dem DB-Commit vorgesehen. Ein Purge-Fehler ist retrybar; die benötigten Handles können aus dem durablen Artifact-Manifest rekonstruiert werden und dürfen nicht durch eine erneute fachliche DB-Anonymisierung ersetzt werden.

## Immutable fachliche Historien

Mehrere Tabellen sind im Normalbetrieb absichtlich gegen UPDATE und DELETE geschützt. Privacy-Verarbeitung darf diese Invariante nicht global abschalten.

### Report-Versionen

Migration `0016_report_privacy_delete.sql` erlaubt DELETE nur für die exakt im Execution-Manifest gebundene `storage_reference`, wenn die Execution zum betroffenen Athleten gehört und bereits `ARTIFACTS_STAGED` ist. UPDATE bleibt immer verboten.

### Testplan-Snapshots

Migration `0017_snapshot_privacy_delete.sql` erlaubt DELETE nur, wenn der Snapshot zu einem Test des Athleten einer aktuell `ARTIFACTS_STAGED`-Execution gehört. Der bestehende UPDATE-Schutz bleibt unverändert.

### Diagnostische Ergebnis-Snapshots

Dieselbe Migration bindet auch deren DELETE-Ausnahme an eine `ARTIFACTS_STAGED`-Execution für den Athleten des Tests. Der bestehende UPDATE-Schutz bleibt unverändert.

Damit gibt es keinen generischen „Privacy-Modus“, der historische Schutztrigger deaktiviert. Zulässig ist nur der eng begrenzte staged-Ausführungszustand unmittelbar vor dem transaktionalen DB-Commit.

## Noch nicht in diesem Slice

Der nächste Slice muss den fachlichen DB-Commit implementieren und dabei:

- Approval unmittelbar vor dem ersten Stage erneut validieren,
- Artifact-Manifest gegen die aktuelle Preview prüfen,
- nach erfolgreichem Stage Audit-Privacy-Redaktionen und sämtliche fachlichen Deletes/Redaktionen in eine gemeinsame DB-Transaktion integrieren,
- Policy-v1.5-Tombstone auf das Athletenprofil anwenden,
- Report-/Export-DB-Records und immutable Snapshots nur über die staged-Ausnahmewege entfernen,
- den Execution-Status innerhalb derselben DB-Transaktion auf `DB_COMMITTED` setzen,
- nach Purge ein PII-freies Abschluss-Audit schreiben.
