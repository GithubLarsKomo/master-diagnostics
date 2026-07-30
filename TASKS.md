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

- [ ] Testzustandsmaschine implementieren
  - [x] Startübergang `PLANNED → IN_PROGRESS` mit Readiness-Gate
  - [x] Abschlussübergang `IN_PROGRESS → DATA_REVIEW` mit strukturiertem Grund
- [ ] timergeführten Ablauf bauen
  - [x] deterministischen, snapshotbasierten Timer-Fachkern implementieren
  - [x] ersten Browserpfad für Planung, Sicherheitscheck, Live-Timer und Abbruch implementieren
- [ ] akustische und visuelle Warnungen
- [ ] Ruhe-, Stufen- und 5-Minuten-Erholungsmessung
  - [x] lokalen Entwurf für Laktat, Qualifier, Herzfrequenz und Messzeit erfassen
  - [x] genau einen Ruhe-/Erholungswert und höchstens einen Wert je Stufe lokal halten
- [ ] IndexedDB-Speicher mit Dexie
  - [x] Timer- und Pausenzustand innerhalb von 500 ms lokal persistieren
  - [x] Messwertentwurf testgebunden in Dexie speichern
- [ ] Wiederaufnahme nach Browser-Neustart
  - [x] laufenden oder pausierten Timer aus dem lokalen Zustand wiederherstellen
  - [x] Messwertentwurf nach Neustart validiert wiederherstellen
- [ ] idempotente Sync-API
  - [x] Messwertoperationen mit globaler `operation_id` höchstens einmal anwenden
  - [x] Ruhe-, Stufen- und Erholungswerte mit optimistischer Version synchronisieren
  - [x] ausstehende Messwertoperationen nach Verbindungsfehler erneut senden
  - [x] Serverkonflikte ohne automatisches Überschreiben lokal sichtbar halten
- [x] exklusive Bearbeitungssperre und Übernahme
- [ ] nachträgliche Tabellenbearbeitung

## Epic 5 — Qualitätsmodell

- [ ] Status `VALID`, `PARTIAL`, `EXCLUDED`, `MISSING`, `MANUALLY_CORRECTED`
- [ ] Teilstufenregel ab mindestens 50 %
- [ ] automatische Plausibilitätswarnungen
- [ ] Messwertkorrektur mit Pflichtvermerk
- [ ] Ausschluss/Wiedereinschluss mit Grund
- [ ] Laktat-Qualifier `EXACT`, `LESS_THAN`, `GREATER_THAN`

## Epic 6 — Diagnostischer Fachkern

- [ ] lineare Interpolation implementieren
- [ ] fixe 2-/4-mmol-Methode
- [ ] Basis +1 mmol/l
- [ ] kubische Regression
- [ ] Dmax
- [ ] modifiziertes Dmax nach geschlossenem ADR
- [ ] Modellgüte und Warnungen
- [ ] deterministische Ergebnis-Hashes
- [ ] Python-Gegenrechnung und Referenzdatensätze
- [ ] Trainerentscheidung und Begründungslogik

## Epic 7 — Trainingszonen

- [ ] physiologisches Drei-Zonen-Modell
- [ ] versionierte Fünf-Zonen-Regel
- [ ] Standardgrenzen 85 % LT1 / LT1 / 95 % LT2 / 102 % LT2
- [ ] schwellenbasierte HF-Zonen
- [ ] offene Z5-Grenze bei fehlender HFmax
- [ ] Trainerkorrektur und Versionierung

## Epic 8 — Dashboards und Bericht

- [ ] aufgabenorientiertes Trainer-Dashboard
- [ ] vollständiges Athleten-Dashboard
- [ ] barrierearme Kurvendiagramme
- [ ] Vergleich bis fünf Tests
- [ ] Vergleichbarkeitsklassifikation
- [ ] unveränderliche Berichtsversionen
- [ ] PDF Deutsch/Englisch

## Epic 9 — Exporte und Portabilität

- [ ] CSV-, JSON- und Markdown-Testexport
- [ ] anonymisierten Analyseexport
- [ ] Seltenheits-/Reidentifikationswarnung
- [ ] vollständigen Tenant-Export
- [ ] verschlüsselte Exportpakete
- [ ] Dry-Run-Import
- [ ] atomaren Import/Rollback
- [ ] Export-/Import-Roundtrip-Test

## Epic 10 — Datenschutz und Audit

- [ ] append-only Audit-Service
- [ ] Audit-Abdeckung aller spezifizierten Ereignisse
- [ ] Aufbewahrungsjob 1–10 Jahre
- [ ] Lösch-/Anonymisierungsanträge und Aufbewahrungsprüfung
- [ ] Pseudonymisierung nach Löschung
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
- [ ] alle Algorithmus-Referenztests bestehen
- [ ] Offline-Wiederaufnahme und Sync-Retry keinen Datenverlust erzeugen
- [ ] WCAG-2.2-AA-Kernprüfungen bestehen
- [ ] Export-/Import-Roundtrip vollständig ist
- [ ] Backup und Restore praktisch getestet wurden
- [ ] deutsch- und englischsprachige Berichte freigegeben sind
