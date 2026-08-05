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

SPEC §33 fordert ein append-only Audit-Log und koppelt die Audit-Aufbewahrung an die Fachdaten, mindestens für drei Jahre. SPEC §33.3 verlangt zusätzlich, direkte Identifikatoren im Audit nach Athletenlöschung zu pseudonymisieren. Historische Audit-Payloads können heute in `before_json`, `after_json` oder Freitext-Begründungen noch direkte Identifikatoren enthalten.

Daraus folgt eine eigene Schutzanforderung:

1. **Normale Audit-Ereignisse bleiben append-only.** Ein Anonymisierungs-Writer darf Historie nicht beliebig überschreiben oder löschen.
2. **Neue Audit-Payloads werden minimiert.** Direkte Identifikatoren werden nur gespeichert, wenn sie für den Audit-Zweck tatsächlich erforderlich sind.
3. **Historische identifierhaltige Audit-Payloads benötigen einen eng begrenzten Privacy-Maintenance-Pfad**, der SPEC §33.3 erfüllt, ohne allgemeine Audit-Editierbarkeit zu eröffnen.
4. Die spätere irreversible Aktion selbst muss als eigenes Audit-Ereignis mit Tenant, Actor, Zeitpunkt, Policy-/Strategieversion, Freigabereferenz, betroffener Entität und Ergebnis protokolliert werden, ohne die entfernten direkten Identifikatoren erneut in den Audit-Payload zu kopieren.

Der row-level Precheck bewertet diese globale Audit-Policy bewusst nicht. Dadurch bleibt die fachliche Datenzustandsprüfung deterministisch, während die Writer-Freigabe zusätzlich eine versionierte globale Policy verlangen kann.

### Minimierung neuer Audit-Payloads

Für neu erzeugte Ereignisse gelten folgende Regeln:

- `athlete.created` und `athlete.updated` behalten den fachlich relevanten alten/neuen Zustand für Nicht-Direktidentifikatoren. `firstName`, `lastName` und `birthDate` werden dabei als `[REDACTED]` gespeichert; `changedFields` hält auch Änderungen dieser redigierten Felder nachvollziehbar.
- `guardian.registered` und `guardian.revoked` speichern Beziehung, Zeit-/Statusdaten und nur boolesche Kontakt-Präsenz; Name, E-Mail und Telefonnummer werden nicht strukturiert dupliziert.
- Löschantrag und Löschentscheidung speichern Request-/Athleten-ID, Status und Zeitpunkte ohne Freitextduplikate im JSON. Die Begründung bleibt entsprechend SPEC §33.2 im dedizierten Audit-Feld `reason` erhalten.
- `athlete.deletion_completed` speichert keinen vollständigen Athleten-Snapshot mehr, sondern nur pseudonyme Zustandsmetadaten; die Abschlussbegründung bleibt im dedizierten `reason`-Feld.
- Technische Athlete-/Request-IDs bleiben als pseudonyme Referenzen erhalten, damit Audit-Ereignisse fachlich zugeordnet werden können.

Freitext-Begründungen können selbst direkte Identifikatoren enthalten. Sie bleiben vorerst erhalten, weil SPEC §33.2 eine Begründung im Audit fordert. Der spätere SPEC-§33.3-Privacy-Maintenance-Pfad muss deshalb neben Legacy-JSON-Payloads ausdrücklich auch `reason` behandeln, ohne die Ereignishistorie allgemein editierbar zu machen.

## Writer-Gates vor Implementierung

Ein produktiver Writer darf erst folgen, wenn mindestens diese Punkte geschlossen sind:

- [x] read-only Datenzustands-Precheck
- [x] identifierhaltige Datenklassen und Artefakte inventarisiert
- [x] Audit-Randbedingungen dokumentiert
- [ ] versioniertes Anonymisierungs-/Entfernungs-Schema je Datenklasse festgelegt
- [x] Audit-Payload-Minimierung für neue Athleten-, Guardian- und Löschereignisse umgesetzt
- [ ] Umgang mit bestehenden identifierhaltigen Audit-Payloads festgelegt
- [ ] Bericht-/Datei-Artefakte in Preview und Ausführung einbezogen
- [ ] Reidentifikationsrisiko für verbleibende Diagnostikdaten bewertet
- [ ] Dry-Run/Preview mit vollständiger Maßnahmenliste implementiert
- [ ] explizite administrative Ausführungsfreigabe und Policy-Version erzwungen
- [ ] irreversible Ausführung mit atomarer Fehlerstrategie und eigenem Audit-Ereignis implementiert

## Nächster technischer Slice

Als nächstes ist der **kontrollierte Privacy-Maintenance-Pfad für identifierhaltigen Audit-Altbestand** zu spezifizieren und DB-seitig abzusichern. Erst danach sollte aus dem Precheck eine vollständige Anonymisierungs-Preview über Profil, Snapshots, Bericht-/Datei-Artefakte und verbleibende Diagnostikdaten abgeleitet werden.
