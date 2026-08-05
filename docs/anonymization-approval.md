# Administrative Freigabe für irreversible Verarbeitung

## Zweck

Die administrative Freigabe ist ein eigener Sicherheitsvertrag zwischen read-only Preview/Policy und einem späteren irreversiblen Writer. Eine abgeschlossene Löschanfrage oder ein grüner Retention-Precheck allein reicht nicht aus.

`approveAthleteAnonymization()` darf ausschließlich von `TENANT_ADMIN` aufgerufen werden und führt selbst **keine** Löschung, Redaktion oder Anonymisierung aus.

## Gebundener Freigabezustand

Jede Approval-Zeile ist append-only und bindet mindestens:

- Tenant und Athlet,
- die tatsächlich abgeschlossene Löschanfrage,
- Approval-Version,
- aktuelle Anonymisierungs-Policy-Version,
- den Zeitpunkt des geprüften Prechecks,
- einen SHA-256-Scope-Fingerprint,
- einen separaten SHA-256-Fingerprint der globalen Privacy-Capability-Attestation,
- freigebenden Tenant-Admin und Freigabezeitpunkt.

Der Scope-Fingerprint wird ausschließlich aus PII-freien technischen Metadaten erzeugt: Scope-Namen, Zeilenzahlen, Artefakt-/Audit-Referenzen, Policy-Dispositionen, Policy-Version und Löschanfrage-ID. Namen, Geburtsdatum und andere direkte Identifikatoren werden weder in die Freigabezeile noch in ihr Audit-Ereignis kopiert.

## Voraussetzungen für eine Freigabe

Eine Approval darf nur entstehen, wenn gleichzeitig:

1. der irreversible Datenzustands-Precheck bestanden ist,
2. eine `COMPLETED`-Löschanfrage zum geprüften Zeitpunkt vorliegt,
3. keine unbekannten row-level oder globalen Policy-Scopes offen sind,
4. die globalen Privacy-Capabilities erfolgreich attestiert sind,
5. als einziger verbleibender Policy-Blocker die administrative Freigabe selbst vorhanden ist,
6. der Actor die Rolle `TENANT_ADMIN` besitzt.

## Unveränderlichkeit

`athlete_anonymization_approvals` ist DB-seitig gegen `UPDATE` und `DELETE` geschützt. Eine Freigabe wird niemals nachträglich angepasst.

Ändert sich der reale Zustand, wird die bestehende Approval stattdessen bei der erneuten Validierung ungültig.

## Fresh Validation vor Ausführung

`validateAthleteAnonymizationApproval()` berechnet vor jeder späteren Ausführung erneut:

- aktuellen irreversiblen Precheck,
- aktuelle abgeschlossene Löschanfrage,
- aktuelle Scope-/Policy-Preview,
- aktuelle globale Privacy-Capability-Attestation,
- Scope- und Capability-Fingerprint.

Die Approval ist nur für die Vorbereitung einer Ausführung gültig, wenn alle Werte weiterhin passen. Strukturierte Blocker sind unter anderem:

- `POLICY_VERSION_CHANGED`,
- `IRREVERSIBLE_PRECHECK_FAILED`,
- `DELETION_REQUEST_CHANGED`,
- `SCOPE_FINGERPRINT_CHANGED`,
- `GLOBAL_PRIVACY_CAPABILITIES_NOT_READY`,
- `GLOBAL_PRIVACY_CAPABILITY_FINGERPRINT_CHANGED`.

Damit kann eine nachträglich hinzugekommene Guardian-Zeile, ein neues Artefakt, eine geänderte Policy oder ein geänderter Backup-/Notification-Zustand eine ältere Freigabe nicht still weiter gültig lassen.

## Audit

Die Erstellung wird als `athlete.anonymization_approved` auditiert. Der Audit-Payload enthält nur technische IDs, Versionen und Fingerprints, keine entfernten oder zu entfernenden direkten Identifikatoren.

## Keine Portabilität von Autorisierung

Administrative Approvals sind **keine fachlichen Tenant-Daten**, sondern zeitpunktgebundene Sicherheitsautorisierungen. Sie werden deshalb nicht als wiederverwendbare Freigabe über Tenant-Export/Import oder Restore betrachtet.

Nach Restore, Import oder anderem Betriebswechsel muss vor irreversibler Verarbeitung eine neue Approval auf Basis des dann aktuellen Scopes und der dann aktuellen Runtime-Capabilities erzeugt werden. Ein späterer Writer darf eine Freigabe ausschließlich aus der aktiven Datenbank und nach erfolgreicher Fresh Validation akzeptieren.

## Nächster Schritt

Nach diesem Vertrag darf als nächster eigener Slice ein atomarer irreversibler Writer entworfen werden. Er muss die Approval unmittelbar vor Beginn erneut validieren, externe Artefakte in definierter Reihenfolge behandeln, DB-Änderungen atomar ausführen und ein eigenes PII-freies Abschluss-Audit schreiben.
