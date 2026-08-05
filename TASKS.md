# TASKS.md — priorisierte Umsetzung

## Epic 0 — Repository und Qualitätsgates

- [x] Monorepo-Grundstruktur erzeugen
- [x] Next.js-, Drizzle- und Docker-Basis anlegen
- [x] CI für Lint, Typecheck, Unit-, Build- und Browser-E2E-Tests
- [x] Dependabot für pnpm und GitHub Actions konfigurieren
- [x] vorläufige Lizenzentscheidung dokumentieren
- [x] CODEOWNERS ergänzen
- [ ] Branch-Protection für `main` in GitHub aktivieren

## Epic 1 — Lokaler Bootstrap und Tenancy

- [x] Better Auth für den lokalen Club-Modus integrieren
- [x] browserbasierten Setup-Assistenten implementieren
- [x] Single-Tenant-Invariante im Club-Modus erzwingen
- [x] ersten Tenant-Admin atomar erzeugen
- [x] Tenant-Kontext-Middleware implementieren
- [x] Rollenmatrix und Tenant-Isolation als Policy-Tests abdecken
- [x] providerneutrale Identity-Schnittstelle vorbereiten
- [ ] Clerk-Adapter für den späteren SaaS-Modus implementieren
- [ ] frische Docker-Installation als eigener Smoke-Test in CI ausführen

**Akzeptanz:** Der lokale Club-Bootstrap, die Anmeldung als Tenant-Admin und die Sperre einer erneuten Einrichtung sind im Browser-E2E-Test nachgewiesen. Der Docker-Smoke-Test bleibt als separates Betriebs-Gate offen.

## Epic 2 — Athleten und Einwilligungen

- [x] Athleten-CRUD für Anlage, Anzeige und Änderung mit Pflichtfeldern
- [x] verwaltete Profile ohne Login
- [x] Many-to-many Trainerzuordnung mit Haupttrainer
- [x] unveränderliche Athleten-Snapshots
- [x] Einwilligungsworkflow
- [x] Minderjährigen- und Guardian-Workflow
- [x] Widerruf und sofortige Nutzungssperre

**Akzeptanz:** Tenantgebundene Athletenverwaltung, Trainerzuordnung, Snapshots, Einwilligungen, sofortige Nutzungssperre bei Widerruf und Guardian-Pflicht für Minderjährige sind durch Integrations- und Browser-E2E-Tests abgedeckt. Lösch-/Anonymisierungsanträge, Aufbewahrungsprüfung und nachgelagerte Pseudonymisierung werden zusammenhängend in Epic 10 umgesetzt.

## Epic 3 — Protokolle und Testplanung

- [x] drei Werksvorlagen seed-en
- [x] versionierte Tenant-Vorlagen
- [x] erwartete LT2 als Planungseingabe
- [x] Berechnung Start = 60 % LT2, LT2 in Stufe 5
- [x] Rundung auf 5 W und Warnregeln
- [x] unveränderlichen Testplan-Snapshot erzeugen
- [x] Sicherheitscheckliste vor Start

## Epic 4 — Testdurchführung und Offline

- [x] Testzustandsmaschine implementieren
  - [x] Startübergang `PLANNED → IN_PROGRESS` mit Readiness-Gate
  - [x] Abschlussübergang `IN_PROGRESS → DATA_REVIEW` mit strukturiertem Grund
- [x] timergeführten Ablauf bauen
  - [x] deterministischen, snapshotbasierten Timer-Fachkern implementieren
  - [x] ersten Browserpfad für Planung, Sicherheitscheck, Live-Timer und Abbruch implementieren
- [x] akustische und visuelle Warnungen
- [x] Ruhe-, Stufen- und 5-Minuten-Erholungsmessung
  - [x] lokalen Entwurf für Laktat, Qualifier, Herzfrequenz und Messzeit erfassen
  - [x] genau einen Ruhe-/Erholungswert und höchstens einen Wert je Stufe lokal halten
  - [x] Vollständigkeit über Ruhewert, alle Stufen und 5-Minuten-Erholung deterministisch prüfen und sichtbar machen
- [x] IndexedDB-Speicher mit Dexie
  - [x] Timer- und Pausenzustand innerhalb von 500 ms lokal persistieren
  - [x] Messwertentwurf testgebunden in Dexie speichern
- [x] Wiederaufnahme nach Browser-Neustart
  - [x] laufenden oder pausierten Timer aus dem lokalen Zustand wiederherstellen
  - [x] Messwertentwurf nach Neustart validiert wiederherstellen
- [x] idempotente Sync-API
  - [x] Messwertoperationen mit globaler `operation_id` höchstens einmal anwenden
  - [x] Ruhe-, Stufen- und Erholungswerte mit optimistischer Version synchronisieren
  - [x] ausstehende Messwertoperationen nach Verbindungsfehler erneut senden
  - [x] Serverkonflikte ohne automatisches Überschreiben lokal sichtbar halten
- [x] exklusive Bearbeitungssperre und Übernahme
- [x] nachträgliche Tabellenbearbeitung

**Akzeptanz:** Der Browser-E2E-Smoke-Test deckt Start und Abschluss der Zustandsmaschine, timergeführten Ablauf, lokale Dexie-Persistenz, Wiederaufnahme eines pausierten Tests sowie Messwert-Retry nach simuliertem Verbindungsfehler und Browser-Neustart ohne Datenverlust ab.

## Epic 5 — Qualitätsmodell

- [x] Status `VALID`, `PARTIAL`, `EXCLUDED`, `MISSING`, `MANUALLY_CORRECTED`
- [x] Teilstufenregel ab mindestens 50 %
- [x] automatische Plausibilitätswarnungen
- [x] Messwertkorrektur mit Pflichtvermerk
- [x] Ausschluss/Wiedereinschluss mit Grund
- [x] Laktat-Qualifier `EXACT`, `LESS_THAN`, `GREATER_THAN`

## Epic 6 — Diagnostischer Fachkern

- [x] lineare Interpolation implementieren
- [x] fixe 2-/4-mmol-Methode
- [x] Basis +1 mmol/l
- [x] kubische Regression
- [x] Dmax
- [x] modifiziertes Dmax nach geschlossenem ADR
- [x] Modellgüte und Warnungen
- [x] deterministische Ergebnis-Hashes
  - [x] versionierte kanonische JSON-Serialisierung und SHA-256-Vertrag ergänzen
  - [x] Hash in unveränderliche Ergebnis-Snapshots integrieren und beim Lesen verifizieren
  - [x] append-only Repository-Vertrag für verifizierte Ergebnis-Snapshots ergänzen
- [x] Python-Gegenrechnung und Referenzdatensätze
  - [x] ersten versionierten Referenzdatensatz für fixe Schwellen, Basis +1, Regression und Dmax ergänzen
  - [x] unabhängigen Python-Generator ohne Drittbibliotheken ergänzen
  - [x] weitere klinisch realistische und problematische Referenzdatensätze ergänzen
  - [x] bytegenaue Reproduzierbarkeit des Generators in CI erzwingen
- [x] Trainerentscheidung und Begründungslogik

## Epic 7 — Trainingszonen

- [x] physiologisches Drei-Zonen-Modell
- [x] versionierte Fünf-Zonen-Regel
- [x] Standardgrenzen 85 % LT1 / LT1 / 95 % LT2 / 102 % LT2
- [x] schwellenbasierte HF-Zonen
- [x] offene Z5-Grenze bei fehlender HFmax
- [x] Trainerkorrektur und Versionierung

## Epic 8 — Dashboards und Bericht

- [x] aufgabenorientiertes Trainer-Dashboard
- [x] vollständiges Athleten-Dashboard
- [x] barrierearme Kurvendiagramme
- [x] Vergleich bis fünf Tests
- [x] Vergleichbarkeitsklassifikation
- [x] unveränderliche Berichtsversionen
- [x] PDF Deutsch/Englisch

## Epic 9 — Exporte und Portabilität

- [x] CSV-, JSON- und Markdown-Testexport
- [x] anonymisierten Analyseexport
- [x] Seltenheits-/Reidentifikationswarnung
- [x] vollständigen Tenant-Export
- [x] verschlüsselte Exportpakete
- [x] Dry-Run-Import
- [x] atomaren Import/Rollback
- [x] Export-/Import-Roundtrip-Test

## Epic 10 — Datenschutz und Audit

- [x] append-only Audit-Service
- [ ] Audit-Abdeckung aller spezifizierten Ereignisse
  - [x] Actor-/Session-Kontext für implementierte Kernwriter vereinheitlicht
  - [x] Coverage-Matrix gegen SPEC §33.1 dokumentiert
  - [ ] offene Auth-, Freigabe-, Diagnostik-, Bluetooth- und Betriebsereignisse schließen
- [ ] Aufbewahrungsjob 1–10 Jahre
  - [x] deterministische Fristberechnung und tenantgebundene Athletenbewertung
  - [x] tenantweite read-only Kandidatenermittlung
  - [x] ausführbarer read-only Retention-Job mit tenantweiser Planung und JSON-Ausgabe
  - [ ] produktive Zeitplanung im Deployment/Betrieb
- [ ] Lösch-/Anonymisierungsanträge und Aufbewahrungsprüfung
  - [x] Antrag, Entscheidung und sofortiger Soft-Delete/Nutzungsschutz
  - [x] read-only Aufbewahrungsprüfung für irreversible Verarbeitung
  - [x] Retention-Status in die Löschvorschau integriert
  - [x] read-only Schutzprüfung für Retention, Nutzungssperre, Soft-Delete und abgeschlossenen Löschworkflow
  - [ ] irreversible Verarbeitung nur nach versionierter Policy und expliziter Freigabe
- [ ] Pseudonymisierung nach Löschung
  - [x] Daten-Scope und Audit-Randbedingungen für irreversible Anonymisierung dokumentiert
  - [x] Audit-Payload-Minimierung für neue Athleten-, Guardian- und Löschereignisse
  - [x] read-only Kandidateninventar für identifierhaltigen Audit-Altbestand
  - [ ] kontrollierte, versionierte Privacy-Maintenance-Policy für Audit-Altbestand
  - [ ] versionierte Regeln für Profil, Snapshots, Berichte/Artefakte und verbleibende Diagnostikdaten
- [ ] Betroffenenexport
- [ ] Löschung/Anonymisierung mit Vorschau

## Epic 11 — Bluetooth-Beta

- [ ] Adapter-Schnittstelle
- [ ] Standard-HR-GATT-Profil
- [ ] Concept2-PM5-Adapter
- [ ] Quellenzuordnung je Messgröße
- [ ] Reconnect ohne automatischen Quellenwechsel
- [ ] RP3-Experiment hinter Feature-Flag

## Epic 12 — Betrieb

- [ ] produktives Docker Compose
- [ ] Caddy-TLS und interne Zertifikate dokumentieren
- [ ] verschlüsselte tägliche Backups
- [ ] Restore-Drill und RTO-Test
- [ ] Online-Updateworkflow
- [ ] signierte Offline-Updatepakete
- [ ] Supportexport ohne Diagnostikdaten
- [ ] Lasttests für 10 parallele Tests

## Release-Gates

Ein MVP-Release ist nur zulässig, wenn:

- [x] aktuelle Tenant-Isolations- und Rollen-Policy-Tests bestehen
- [x] alle Algorithmus-Referenztests bestehen
- [x] Offline-Wiederaufnahme und Sync-Retry keinen Datenverlust erzeugen
- [ ] WCAG-2.2-AA-Kernprüfungen bestehen
- [x] Export-/Import-Roundtrip vollständig ist
- [ ] Backup und Restore praktisch getestet wurden
- [x] deutsch- und englischsprachige Berichte freigegeben sind
