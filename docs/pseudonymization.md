# Irreversible Anonymisierung und Pseudonymisierung

## Ziel und Begriffsklärung

SPEC §32 verlangt nach Prüfung der Aufbewahrungsgründe eine Löschung oder **irreversible Anonymisierung**. Das ist strenger als eine gewöhnliche Pseudonymisierung, bei der eine Zuordnung über einen getrennten Schlüssel grundsätzlich wiederherstellbar bleibt.

Für Masters Diagnostics gilt deshalb:

- Soft-Delete (`deleted_at`) ist nur Nutzungssperre und Ausblendung, nicht die endgültige DSGVO-Verarbeitung.
- Ein stabiler technischer `athlete_id` darf für referenzielle Integrität bestehen bleiben, ist für sich allein aber kein Nachweis einer erfolgreichen Anonymisierung.
- Eine spätere irreversible Verarbeitung darf erst implementiert werden, wenn alle Identitätsanker und identifierhaltigen Artefakte im Datenfluss berücksichtigt sind.
- Der read-only Precheck ist nur eine **notwendige Datenzustandsprüfung**, keine Ausführungsfreigabe.

## Read-only Datenzustands-Precheck

`getAthleteIrreversibleProcessingPrecheck()` prüft fail-closed und ohne Datenänderung:

1. Die Retention-Bewertung erlaubt eine irreversible Aktion.
2. Die Nutzungssperre (`consentBlockedAt`) war zum Bewertungszeitpunkt bereits wirksam.
3. Der Soft-Delete (`deletedAt`) war zum Bewertungszeitpunkt bereits wirksam.
4. Es existiert ein abgeschlossener Löschworkflow (`athlete_deletion_requests.status = COMPLETED`) mit `completedAt` spätestens zum Bewertungszeitpunkt.

Blocker werden strukturiert ausgewiesen:

- `RETENTION_ACTIVE`
- `RETENTION_MANUAL_REVIEW`
- `USAGE_NOT_BLOCKED`
- `SOFT_DELETE_NOT_COMPLETED`
- `DELETION_WORKFLOW_NOT_COMPLETED`

`passesPrecheck = true` bedeutet ausdrücklich **nicht**, dass ein Writer ausgeführt werden darf. Zusätzlich müssen eine versionierte Anonymisierungsstrategie, Audit-Regeln und eine explizite Ausführungsfreigabe aktiv sein.

## Daten-Scope eines späteren Writers

Ein Writer darf sich nicht auf die Zeile `athletes` beschränken. Vor Implementierung müssen mindestens folgende Speicherorte klassifiziert werden.

### 1. Aktuelles Athletenprofil

Direkte oder starke Identitätsanker umfassen insbesondere:

- `firstName`
- `lastName`
- `birthDate`
- `linkedUserId`

Auch Kombinationen aus Referenzkategorie, Körpermaßen, Sportart und Historie können die Reidentifikation erleichtern. Welche Felder nach einer Anonymisierung erhalten oder generalisiert werden dürfen, muss vor dem Writer als versionierte Regel festgelegt werden.

### 2. Unveränderliche Snapshots

`athlete_snapshots.snapshot_json` bildet bewusst historische Stammdaten ab. Zusätzlich können `test_plan_snapshots.snapshot_json` oder andere Snapshot-Payloads identifierhaltige Daten übernehmen.

Eine Anonymisierung nur des aktuellen Athletenprofils wäre daher unvollständig. Für unveränderliche Snapshots ist vorab festzulegen, ob sie:

- nach Ablauf der Retention vollständig entfernt,
- durch eine explizit versionierte anonymisierte Repräsentation ersetzt,
- oder unter einer getrennten Aufbewahrungsgrundlage weiter vorgehalten werden.

Diese Entscheidung darf nicht implizit durch den ersten Writer getroffen werden.

### 3. Berichte und externe Artefakte

`report_versions.storage_reference` kann auf bereits gerenderte PDFs mit Name, Geburtsdatum oder weiteren Identifikatoren verweisen. Ein späterer Writer muss daher auch persistierte Berichtartefakte behandeln. Ein bloßes Entfernen der Datenbank-Stammdaten lässt solche Artefakte unverändert identifizierend.

Dasselbe gilt für noch vorhandene Exportpakete und andere gespeicherte Dateien. Ephemere Tenant-Exportpakete besitzen bereits einen separaten Ablauf-/Cleanup-Mechanismus; vor irreversibler Verarbeitung muss trotzdem geprüft werden, ob identifierhaltige Artefakte noch aktiv erreichbar sind.

### 4. Diagnostik- und Messdaten

Tests, Leistungs-, Herzfrequenz- und Laktatdaten können fachlich erhalten bleiben, wenn die spätere Strategie dies vorsieht. Sie sind jedoch nicht automatisch anonym, nur weil Name und Login-Verknüpfung entfernt wurden. Seltene Merkmalskombinationen und Verlaufsdaten können eine Reidentifikation ermöglichen.

Deshalb benötigt der Writer eine explizite Entscheidung zwischen:

- vollständiger Entfernung,
- Beibehaltung unter einem nicht rückführbaren technischen Bezug,
- oder zusätzlicher Generalisierung/Reduktion.

## Audit-Anforderungen

SPEC §33 fordert ein append-only Audit-Log und koppelt die Audit-Aufbewahrung an die Fachdaten, mindestens für drei Jahre. Gleichzeitig können historische Audit-Payloads in `before_json` und `after_json` direkte Athletenstammdaten enthalten, beispielsweise bei Anlage oder Änderung eines Athleten.

Daraus folgt eine eigene Schutzanforderung:

1. **Append-only bleibt unverändert.** Ein Anonymisierungs-Writer darf Audit-Ereignisse nicht still überschreiben oder löschen.
2. **Neue Audit-Payloads werden minimiert.** Direkte Identifikatoren werden nicht mehr automatisch in Athleten- und Löschpayloads kopiert.
3. **Historische identifierhaltige Audit-Payloads benötigen eine definierte Retention-/Migrationsstrategie**, bevor ein produktiver irreversibler Writer freigegeben wird.
4. Die spätere irreversible Aktion selbst muss als eigenes Audit-Ereignis mit Tenant, Actor, Zeitpunkt, Policy-/Strategieversion, Freigabereferenz, betroffener Entität und Ergebnis protokolliert werden, ohne die entfernten direkten Identifikatoren erneut in den Audit-Payload zu kopieren.

Der row-level Precheck bewertet diese globale Audit-Policy bewusst nicht. Dadurch bleibt die fachliche Datenzustandsprüfung deterministisch, während die Writer-Freigabe zusätzlich eine versionierte globale Policy verlangen kann.

### Audit-Payload-Minimierung ab Schema-Version 2

Für neu erzeugte Athleten- und Löschereignisse gilt:

- `firstName`, `lastName` und `birthDate` werden im Athlete-Audit nur als `[REDACTED]` gespeichert.
- Fachlich relevante Nicht-Direktidentifikatoren wie Referenzkategorie, Körpermaße, Sportart, Disziplin und Trainingsstatus bleiben als alter/neuer Zustand auditierbar.
- `changedFields` hält auch Änderungen an redigierten Direktidentifikatoren nachvollziehbar, ohne deren Werte zu persistieren.
- `linkedUserId` wird in Löschpayloads nicht gespeichert; es wird nur festgehalten, ob eine Verknüpfung vorhanden war.
- Gründe von Löschantrag, Entscheidung und Abschluss werden ausschließlich im dafür vorgesehenen Audit-Feld `reason` gehalten und nicht zusätzlich in `before_json`/`after_json` dupliziert.
- Technische `athleteId`-/Request-IDs bleiben als pseudonyme Referenzen erhalten, damit der Audit-Trail fachlich zuordenbar bleibt.

Diese Änderung wirkt nur für neue Audit-Ereignisse. Bereits vorhandene Zeilen werden wegen der append-only Semantik nicht still verändert. Der Umgang mit historischem Altbestand bleibt ein explizites separates Gate.

## Writer-Gates vor Implementierung

Ein produktiver Writer darf erst folgen, wenn mindestens diese Punkte geschlossen sind:

- [x] read-only Datenzustands-Precheck
- [x] identifierhaltige Datenklassen und Artefakte inventarisiert
- [x] Audit-Randbedingungen dokumentiert
- [ ] versioniertes Anonymisierungs-/Entfernungs-Schema je Datenklasse festgelegt
- [x] Audit-Payload-Minimierung für neue Athleten- und Löschereignisse umgesetzt
- [ ] Umgang mit bestehenden identifierhaltigen Audit-Payloads festgelegt
- [ ] Bericht-/Datei-Artefakte in Preview und Ausführung einbezogen
- [ ] Reidentifikationsrisiko für verbleibende Diagnostikdaten bewertet
- [ ] Dry-Run/Preview mit vollständiger Maßnahmenliste implementiert
- [ ] explizite administrative Ausführungsfreigabe und Policy-Version erzwungen
- [ ] irreversible Ausführung mit atomarer Fehlerstrategie und eigenem Audit-Ereignis implementiert

## Nächster technischer Slice

Als nächstes muss für bereits vorhandene identifierhaltige Audit-Payloads eine mit SPEC §33.3 und der append-only Semantik vereinbare Altbestand-Strategie festgelegt werden. Danach kann aus dem Precheck eine vollständige Anonymisierungs-Preview über Profil, Snapshots, Berichte/Dateiartefakte und verbleibende Diagnostikdaten abgeleitet werden.
