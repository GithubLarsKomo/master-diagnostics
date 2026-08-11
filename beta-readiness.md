# Beta Readiness — master-diagnostics

Stand: 2026-08-11  
Head: `e82cb14c5318de140b5ee96b288aaba8840ddfe9`

## Beta-Definition

Die erste Beta ist erreicht, wenn ein Trainer im lokalen Club-Modus einen Athleten verwalten, einen Laktattest planen und offline-sicher durchführen, Ergebnisse diagnostisch auswerten und vergleichen sowie einen freigegebenen deutsch- oder englischsprachigen Bericht mit dokumentiertem Setup und Recovery erzeugen kann, ohne dass ein explizites MVP-Release-Gate offen bleibt.

## Ergebnis

**96 % — noch nicht Beta.**

| Dimension | Punkte |
|---|---:|
| Kernnutzen und Scope | 20/20 |
| Vertikaler End-to-End-Pfad | 20/20 |
| Daten, Fehlerfälle und Wiederaufnahme | 14/15 |
| Verifikation | 20/20 |
| Bedienbarkeit und Deployment | 14/15 |
| Beta-Betrieb und Anleitung | 8/10 |
| **Gesamt** | **96/100** |

## Evidenz

- Der Club-Beta-Kernpfad ist fachlich umgesetzt: Athleten, Einwilligungen, Protokollplanung, timergeführte Testdurchführung, Offline-Persistenz/Wiederaufnahme, Qualitätsmodell, Diagnostik, Trainingszonen, Dashboards, Vergleich und Reports.
- Browser-E2E belegt Setup, Live-Test, Dexie-Persistenz, Browser-Neustart und Sync-Retry ohne Datenverlust.
- Export-/Import-Roundtrip ist vollständig, inklusive Dry-Run, atomarem Import/Rollback und Roundtrip-Test.
- Deutsch- und englischsprachige Berichte sind als Release-Gate freigegeben.
- Eine frische Docker-Installation ist als eigener CI-Smoke-Test bis zum HTTPS-Healthcheck nachgewiesen.
- CI umfasst Lint, Typecheck, Unit, Build, Browser-E2E und zahlreiche Betriebs-/Restore-Verträge.
- Der Online-Update-Rollback ist mit signiertem Plan, verifizierter Restore-Promotion, Rollback Receipt und eigenem Executor-Contract fail-closed abgesichert.
- Der automatisierte WCAG-Core-Browservertrag ist auf `main` gemergt und deckt Accessible Names, Main/H1-Struktur, Heading-Hierarchie, Keyboard-Fokus, sichtbaren Fokus sowie 320-CSS-px-Reflow auf stabilen Club-Beta-Oberflächen ab. Ein dabei entdeckter realer Reflow-Fehler auf der Trainer-Startseite wurde behoben und die vollständige CI danach grün verifiziert.
- Für den praktischen Restore-Drill existiert jetzt ein reproduzierbares Host-Runbook plus ein fail-closed Evidence-Checker, der den signierten RTO-Report mit Host/Commit, Healthcheck, Trainer-Lesepfad, Datenstichprobe, Caddy-Zustand und Volume-Verlustprüfung verknüpft.

## Harte Beta-Blocker

1. **WCAG-2.2-AA-Kernprüfungen** sind als explizites MVP-Release-Gate noch offen. Der automatisierte Kernnachweis ist grün; offen bleibt die dokumentierte manuelle Abnahme für kompletten Keyboardpfad, Screenreader-Semantik, Kontrast, 200/400-%-Zoom/Reflow, Text Spacing, Statusmeldungen, Diagramm-Alternative und Reportpfad.
2. **Backup und Restore praktisch getestet** ist als explizites MVP-Release-Gate noch offen. Technischer Drill, signierter RTO-Report, unabhängige Verifikation und Operator-Evidence-Gate sind vorbereitet, ersetzen aber keinen dokumentierten realen Host-Drill.

## Beta-Follow-ups

- vollständige Audit-Abdeckung der noch offenen Auth-, Freigabe-, Diagnostik-, Bluetooth- und Betriebsereignisse,
- produktive Privacy-Capability-Attestation erst bei Aktivierung von Backup/Notifications,
- Bluetooth-/PM5-/RP3-Beta,
- Clerk-Adapter für einen späteren SaaS-Modus,
- signierte Offline-Updatepakete,
- Supportexport ohne Diagnostikdaten,
- Lasttest für 10 parallele Tests.

Diese Punkte gehören nicht zum kleinsten definierten Club-Beta-Pfad und senken daher den Beta-Readiness-Wert nicht als harte Blocker.

## UI-Prototyp

**Nicht empfohlen.** Der zentrale Trainerpfad ist bereits browserseitig implementiert. Die verbleibenden Beta-Risiken liegen in manueller Accessibility-Evidence und realer Betriebs-Recovery, nicht in ungeklärter Informationsarchitektur oder Interaktion.

## Nächste Schritte

1. Die manuelle WCAG-2.2-AA-Kernabnahme anhand `docs/wcag-beta-core-checklist.md` auf dem aktuellen `main` durchführen, Evidence archivieren und das Release-Gate nur bei vollständigem Bestehen schließen.
2. Einen realen Club-Host-Restore-Drill anhand `docs/beta-restore-drill-runbook.md` durchführen und die finale Operator-Evidence mit `infra/backup/check-beta-restore-drill-evidence.py` fail-closed verifizieren.
3. Nach Schließen beider Gates die Bewertung erneut auf 100 % ausführen und daraus das erste `beta-runbook.md` erzeugen.
