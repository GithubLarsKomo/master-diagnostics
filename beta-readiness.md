# Beta Readiness — master-diagnostics

Stand: 2026-08-11  
Head: `6cb7a10e038f1a93c19938c3b61a9e8b71bf1d1a`

## Beta-Definition

Die erste Beta ist erreicht, wenn ein Trainer im lokalen Club-Modus einen Athleten verwalten, einen Laktattest planen und offline-sicher durchführen, Ergebnisse diagnostisch auswerten und vergleichen sowie einen freigegebenen deutsch- oder englischsprachigen Bericht mit dokumentiertem Setup und Recovery erzeugen kann, ohne dass ein explizites MVP-Release-Gate offen bleibt.

## Ergebnis

**94 % — noch nicht Beta.**

| Dimension | Punkte |
|---|---:|
| Kernnutzen und Scope | 20/20 |
| Vertikaler End-to-End-Pfad | 20/20 |
| Daten, Fehlerfälle und Wiederaufnahme | 14/15 |
| Verifikation | 20/20 |
| Bedienbarkeit und Deployment | 13/15 |
| Beta-Betrieb und Anleitung | 7/10 |
| **Gesamt** | **94/100** |

## Evidenz

- Der Club-Beta-Kernpfad ist fachlich umgesetzt: Athleten, Einwilligungen, Protokollplanung, timergeführte Testdurchführung, Offline-Persistenz/Wiederaufnahme, Qualitätsmodell, Diagnostik, Trainingszonen, Dashboards, Vergleich und Reports.
- Browser-E2E belegt Setup, Live-Test, Dexie-Persistenz, Browser-Neustart und Sync-Retry ohne Datenverlust.
- Export-/Import-Roundtrip ist vollständig, inklusive Dry-Run, atomarem Import/Rollback und Roundtrip-Test.
- Deutsch- und englischsprachige Berichte sind als Release-Gate freigegeben.
- Eine frische Docker-Installation ist als eigener CI-Smoke-Test bis zum HTTPS-Healthcheck nachgewiesen.
- CI umfasst Lint, Typecheck, Unit, Build, Browser-E2E und zahlreiche Betriebs-/Restore-Verträge.
- Der Online-Update-Rollback ist mit signiertem Plan, verifizierter Restore-Promotion, Rollback Receipt und eigenem Executor-Contract fail-closed abgesichert.

## Harte Beta-Blocker

1. **WCAG-2.2-AA-Kernprüfungen** sind als explizites MVP-Release-Gate noch offen.
2. **Backup und Restore praktisch getestet** ist als explizites MVP-Release-Gate noch offen. Die technische Restore-/Promotion-Kette ist stark automatisiert und verifiziert, ersetzt aber keinen dokumentierten realen Host-Drill.

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

**Nicht empfohlen.** Der zentrale Trainerpfad ist bereits browserseitig implementiert. Die verbleibenden Beta-Risiken liegen in Accessibility-Evidence und realer Betriebs-Recovery, nicht in ungeklärter Informationsarchitektur oder Interaktion.

## Nächste Schritte

1. WCAG-2.2-AA-Kernprüfung für Setup, Login, Trainer-Startseite, Athletenverwaltung, Testplanung/-durchführung, Review und Reportpfad automatisieren und das Release-Gate nur bei grünem Nachweis schließen.
2. Einen realen Club-Host-Restore-Drill mit einem verschlüsselten Backup durchführen, Privacy-Reconciliation, Healthcheck und kontrollierte Promotion nachweisen und die signierte RTO-/Restore-Evidence archivieren.
3. Nach Schließen beider Gates die Bewertung erneut auf 100 % ausführen und daraus das erste `beta-runbook.md` erzeugen.
