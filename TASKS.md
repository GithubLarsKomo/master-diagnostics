# TASKS.md — priorisierte Umsetzung

## Epic 0 — Repository und Qualitätsgates

- [x] Monorepo-Grundstruktur erzeugen
- [x] Next.js-, Drizzle- und Docker-Basis anlegen
- [ ] CI für Lint, Typecheck, Unit- und Build-Tests
- [ ] Dependabot/Renovate konfigurieren
- [ ] Lizenzentscheidung dokumentieren
- [ ] Branch-Protection und CODEOWNERS aktivieren

## Epic 1 — Lokaler Bootstrap und Tenancy

- [ ] Better Auth vollständig integrieren
- [ ] browserbasierten Setup-Assistenten implementieren
- [ ] Single-Tenant-Invariante im Club-Modus erzwingen
- [ ] ersten Tenant-Admin atomar erzeugen
- [ ] Tenant-Kontext-Middleware implementieren
- [ ] Rollenmatrix als Policy-Tests abdecken
- [ ] SaaS-Provider-Schnittstelle für Clerk vorbereiten

**Akzeptanz:** Eine frische Docker-Installation kann ohne Internet initialisiert werden; anschließend ist eine Anmeldung als Tenant-Admin möglich.

## Epic 2 — Athleten und Einwilligungen

- [ ] Athleten-CRUD mit Pflicht-/Optionalfeldern
- [ ] verwaltete Profile ohne Login
- [ ] Many-to-many Trainerzuordnung mit Haupttrainer
- [ ] unveränderliche Athleten-Snapshots
- [ ] Einwilligungsworkflow
- [ ] Minderjährigen- und Guardian-Workflow
- [ ] Widerruf, Nutzungssperre und Löschantrag

## Epic 3 — Protokolle und Testplanung

- [ ] drei Werksvorlagen seed-en
- [ ] versionierte Tenant-Vorlagen
- [ ] erwartete LT2 als Planungseingabe
- [ ] Berechnung Start = 60 % LT2, LT2 in Stufe 5
- [ ] Rundung auf 5 W und Warnregeln
- [ ] unveränderlichen Testplan-Snapshot erzeugen
- [ ] Sicherheitscheckliste vor Start

## Epic 4 — Testdurchführung und Offline

- [ ] Testzustandsmaschine implementieren
- [ ] timergeführten Ablauf bauen
- [ ] akustische und visuelle Warnungen
- [ ] Ruhe-, Stufen- und 5-Minuten-Erholungsmessung
- [ ] IndexedDB-Speicher mit Dexie
- [ ] Wiederaufnahme nach Browser-Neustart
- [ ] idempotente Sync-API
- [ ] exklusive Bearbeitungssperre und Übernahme
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

- [ ] alle Tenant-Isolationstests bestehen
- [ ] alle Algorithmus-Referenztests bestehen
- [ ] Offline-Wiederaufnahme und Sync-Retry keinen Datenverlust erzeugen
- [ ] WCAG-2.2-AA-Kernprüfungen bestehen
- [ ] Export-/Import-Roundtrip vollständig ist
- [ ] Backup und Restore praktisch getestet wurden
- [ ] deutsch- und englischsprachige Berichte freigegeben sind
