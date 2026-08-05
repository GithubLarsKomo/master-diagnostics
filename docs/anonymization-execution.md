# Irreversible Anonymisierungs-Ausführung

## Zweck

Die irreversible Athletenverarbeitung wird bewusst **nicht** als scheinbar atomare Operation über Datenbank und Dateisystem modelliert. SQLite/libSQL kann externe Report-PDFs, verschlüsselte Tenant-Exportpakete und verschlüsselte Betroffenenexportpakete nicht in dieselbe Transaktion einbeziehen.

Der implementierte Ablauf verwendet deshalb einen durablen Zwei-Phasen-Vertrag mit Recovery:

1. Approval unmittelbar vor dem ersten Dateizugriff frisch validieren.
2. Aktuelle Preview gegen das unveränderliche Execution-Manifest prüfen.
3. Externe Artefakte in eine ausführungsgebundene Quarantäne verschieben.
4. Erst nach vollständig erfolgreichem Stage `ARTIFACTS_STAGED` setzen.
5. Sämtliche fachlichen DB-Änderungen einschließlich Audit-Privacy-Redaktion in **einer** DB-Transaktion durchführen und darin `DB_COMMITTED` setzen.
6. Nach dauerhaftem DB-Commit die Quarantäne anhand des Manifests endgültig löschen.
7. Erst nach erfolgreichem Purge `COMPLETED` setzen und den PII-freien Abschluss-Audit schreiben.

## Durable Execution State

`athlete_anonymization_executions` ist ein PII-armer technischer Nachweis für genau eine gebundene Approval. Pro Approval existiert höchstens eine Execution.

Version: `1`.

Zulässige Zustände:

- `PREPARING`
- `ARTIFACTS_STAGED`
- `DB_COMMITTED`
- `COMPLETED`
- `ABORTED`

```text
PREPARING ────────> ARTIFACTS_STAGED ────────> DB_COMMITTED ────────> COMPLETED
    │                       │
    └───────> ABORTED <─────┘
```

Die Datenbanktrigger schützen Identität und Übergänge. Execution-Zeilen dürfen nicht gelöscht werden.

### Irreversible Grenze

`DB_COMMITTED` ist die harte irreversible Grenze. Danach ist **kein** Restore der Artefakte und **kein** erneuter fachlicher DB-Commit zulässig. Ein Prozessabsturz oder Purge-Fehler hinterlässt den Lauf absichtlich in `DB_COMMITTED`; Recovery führt ausschließlich den manifestbasierten Purge und anschließend `COMPLETED` aus.

`recoverCommittedAthleteAnonymization()` validiert deshalb die alte Approval nicht erneut und spielt die fachliche DB-Mutation nie erneut ab.

## Durables Artifact-Manifest

`athlete_anonymization_execution_artifacts` hält die beim Prepare gebundenen externen Referenzen unabhängig von deren späteren fachlichen Quellzeilen fest:

- `REPORT` für Report-PDFs,
- `TENANT_EXPORT` für vollständige Tenant-Exportpakete (`.mde`),
- `DATA_SUBJECT_EXPORT` für athletenbezogene Betroffenenexportpakete (`.mdse`).

Migration `0021_data_subject_anonymization_artifacts` erweitert ausschließlich den bestehenden Insert-Validator um `DATA_SUBJECT_EXPORT`. Die bestehenden Immutability-Trigger für Update und Delete bleiben unverändert aktiv.

Die Manifestzeilen sind immutable und nicht löschbar. Sie enthalten nur Execution-/Tenant-Bezug, Artefaktart und technische `storage_reference`.

Dadurch kann ein Prozess nach `DB_COMMITTED` den Purge fortsetzen, obwohl `report_versions`, `tenant_export_packages` und `athlete_data_subject_delivery_packages` bereits aus der fachlichen Datenbank entfernt wurden.

## Policy 1.6.0 und Preview-Scope

Policy `1.6.0` erweitert den irreversiblen Scope um `DATA_SUBJECT_DELIVERY_PACKAGES` mit der Disposition `REMOVE_DATA_SUBJECT_DELIVERY_PACKAGES`.

Grund: Ein bereits erzeugtes `.mdse` kann den vollständigen, vor der Anonymisierung freigegebenen Betroffenenexport enthalten. Das gilt unabhängig davon, ob das Paket noch downloadbar, bereits konsumiert oder abgelaufen ist. Deshalb inventarisiert die Preview **alle** `athlete_data_subject_delivery_packages` des betroffenen Athleten tenantgebunden und nicht nur aktuell aktive Pakete.

Der Policy-Versionssprung invalidiert ältere Anonymisierungs-Approvals bewusst. Eine Approval aus Policy 1.5 darf nicht zur Ausführung unter erweitertem Artefakt-Scope verwendet werden.

## Vorbereitung und Fresh-Validation

`prepareAthleteAnonymizationExecution()`:

- akzeptiert ausschließlich `TENANT_ADMIN`,
- revalidiert Approval, Precheck, Scope und Runtime-Capabilities,
- erzeugt genau eine Execution pro Approval,
- persistiert Execution und Artifact-Manifest gemeinsam,
- mutiert keine Athleten-, Diagnostik- oder Artefaktdaten,
- schreibt einen PII-freien Prepare-Audit.

Unmittelbar vor dem ersten Quarantäne-`rename()` validiert der Orchestrator erneut:

- die gebundene Approval,
- aktuellen Precheck und Policy 1.6,
- Backup-/Notification-Runtime-Capabilities,
- vollständige Übereinstimmung aktueller Reportreferenzen mit dem `REPORT`-Manifest,
- vollständige Übereinstimmung aktiver Tenant-Exportreferenzen mit dem `TENANT_EXPORT`-Manifest,
- vollständige Übereinstimmung aller athletenbezogenen Betroffenenexportreferenzen mit dem `DATA_SUBJECT_EXPORT`-Manifest.

Jede Drift bricht vor dem Dateistaging fail-closed ab.

## Artifact Quarantine

Report-, Tenant-Export- und Betroffenenexport-Storage unterstützen denselben Vertrag:

- `stageForDeletion(executionId, reference)`
- `restoreStaged(handle)`
- `purgeStaged(handle)`

Die File-System-Implementierungen verschieben Dateien per `rename()` innerhalb desselben Storage-Roots nach `.anonymization-quarantine/<executionId>/...`.

Eigenschaften:

- große Dateien werden nicht in den Arbeitsspeicher geladen,
- Stage ist idempotent,
- ein Artefakt darf nicht gleichzeitig aktiv und quarantänisiert existieren,
- Restore ist vor DB-Commit idempotent möglich,
- Purge ist nach DB-Commit idempotent,
- unsichere Execution-IDs und Storage-Referenzen werden vor Pfadkonstruktion verworfen.

`stageAnonymizationArtifacts()` behandelt alle drei Artefaktklassen als Gruppe. Scheitert ein späteres Stage, werden bereits verschobene Dateien in umgekehrter Reihenfolge restauriert. Ein unvollständiger Restore bleibt als Fehler sichtbar und darf nicht als erfolgreicher Abort kaschiert werden.

## Transaktionaler DB-Commit

`commitStagedAthleteAnonymizationDatabase()` akzeptiert ausschließlich eine passende `ARTIFACTS_STAGED`-Execution und prüft unmittelbar vor dem Commit erneut Approval, Policy und gebundenen Scope.

Innerhalb **einer** Datenbanktransaktion werden unter anderem geprüft:

- Execution weiterhin `ARTIFACTS_STAGED`,
- Approval weiterhin an aktuelle Policy gebunden,
- Athlet weiterhin soft-deleted und nutzungsgesperrt,
- Löschworkflow weiterhin abgeschlossen,
- Reportreferenzen weiterhin exakt gleich Manifest,
- kein neuer aktiver Tenant-Export außerhalb des Manifests,
- manifestierte Tenant-Export-Quellzeilen weiterhin vorhanden,
- aktueller vollständiger Satz athletenbezogener Betroffenenexportreferenzen exakt gleich `DATA_SUBJECT_EXPORT`-Manifest.

Damit blockiert auch ein zwischen Preparation und Commit neu erzeugtes oder verschwundenes `.mdse` den Commit fail-closed.

Danach erfolgen in FK-sicherer Reihenfolge:

- historische Audit-Privacy-Redaktionen,
- Entfernung von Reports, Zonen, Interpretationen, Thresholds und diagnostischen Snapshots,
- Entfernung von Mess-, Qualitäts-, Korrektur-, Sync-, Lock-, Safety-, Termination- und Testdaten,
- Entfernung von Athlete-Snapshots, Coach-Zuordnungen und Guardian-Daten,
- Entfernung der manifestierten aktiven Tenant-Exportpaket-Zeilen,
- Entfernung sämtlicher manifestierter `athlete_data_subject_delivery_packages` des Athleten,
- Redigierung der Freitexte im Löschworkflow bei Erhalt von Status und Zeitpunkten,
- Anwendung des Policy-v1.5 eingeführten minimalen Athleten-Tombstones, der unter Policy 1.6 unverändert weitergilt,
- Übergang `ARTIFACTS_STAGED -> DB_COMMITTED`,
- PII-freier `athlete.anonymization_db_committed`-Audit.

Einwilligungsnachweise bleiben als minimierte Compliance-Datensätze erhalten. Ein DB-Fehler rollt sämtliche fachlichen Änderungen, Audit-Redaktionen und den Execution-Status gemeinsam zurück. Der Orchestrator restauriert dann die zuvor quarantänisierten Dateien aller drei Artefaktklassen und setzt die Execution erst nach erfolgreichem Restore auf `ABORTED`.

## Immutable fachliche Historien

Privacy-Verarbeitung schaltet bestehende Immutability-Regeln nicht global ab. DELETE ist nur in einer zum betroffenen Athleten gehörenden `ARTIFACTS_STAGED`-Execution zulässig; UPDATE bleibt geschützt.

Dies gilt für:

- `report_versions` — zusätzlich exakt an die manifestierte `storage_reference` gebunden,
- `test_plan_snapshots`,
- `diagnostic_result_snapshots`,
- `test_safety_checklist_confirmations`,
- `test_termination_events`.

`athlete_data_subject_delivery_packages` besitzen einen eigenen Immutability-Vertrag für ihre technischen Metadaten und den One-Time-Consume-Übergang. Ihre Löschung ist im irreversiblen Athleten-Commit zulässig, weil die zugehörigen verschlüsselten Dateien durch das Execution-Manifest und die Quarantäne gebunden sind.

Damit existiert kein generischer „Privacy-Modus“, der historische Schutztrigger deaktiviert.

## End-to-End-Orchestrator und Recovery

`executeAthleteAnonymization()` verbindet die Phasen zu einem recovery-sicheren Ablauf:

- `COMPLETED` wird idempotent zurückgegeben,
- `DB_COMMITTED` führt ausschließlich Purge + Completion aus,
- `ABORTED` kann nicht mit derselben Approval erneut gestartet werden,
- `PREPARING` führt Fresh-Validation und Staging aus,
- `ARTIFACTS_STAGED` kann nach Prozessneustart idempotent fortgesetzt werden,
- DB-Fehler vor `DB_COMMITTED` führen nach vollständigem Restore zu `ABORTED`,
- unvollständiger Restore bleibt recoverbar,
- Purge-Fehler nach `DB_COMMITTED` führen niemals zu DB-Replay oder Restore.

Die Zustandswechsel `ARTIFACTS_STAGED`, `ABORTED`, `DB_COMMITTED` und `COMPLETED` werden PII-arm auditiert.

Regressionstests decken insbesondere ab:

- erfolgreichen gemeinsamen Purge von Report, Tenant-Export und `.mdse`,
- vollständige DB-Entfernung der zugehörigen Paketzeilen,
- Restore aller Artefaktklassen bei Scope-Drift,
- neue `.mdse`-Zeile nach Preparation als Commit-Blocker,
- `DB_COMMITTED`-Recovery ohne erneute Fachmutation.

## Schutz gegen parallelen Cleanup

Der normale Cleanup abgelaufener Tenant-Exportpakete wird für einen Tenant pausiert, solange eine Anonymisierungs-Execution `PREPARING` oder `ARTIFACTS_STAGED` ist. Dadurch kann keine manifestierte Tenant-Exportzeile zwischen Quarantäne und DB-Commit verschwinden.

Der normale Lifecycle-Cleanup für konsumierte/abgelaufene Betroffenenexportpakete ist ein separater Betriebs-Slice. Er muss dieselbe Execution-Grenze respektieren und darf eine manifestierte `.mdse`-Zeile während `PREPARING` oder `ARTIFACTS_STAGED` nicht entfernen.

## Betriebsgrenze

Der irreversible technische Ablauf ist durch echte SQLite-Migrationen, Dateisystemtests, Build und Browser-E2E abgesichert. Eine öffentliche Web-Route ist bewusst nicht Teil dieses Ausführungsdienstes.

Vor produktiver Nutzung müssen die in `docs/global-privacy-policy.md` definierten Backup-/Notification-Capabilities für das tatsächliche Deployment attestiert sein. Fehlende oder unbekannte Runtime-Fähigkeiten bleiben fail-closed.
