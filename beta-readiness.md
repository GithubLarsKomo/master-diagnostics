# Beta Readiness — master-diagnostics

Stand: 2026-08-02  
Head: `2d7b7a93842af4d0d8de121e78871908ff6301c9`

## Beta-Definition

Die erste Beta ist erreicht, wenn ein Trainer im lokalen Club-Modus einen Athleten verwalten, einen Laktattest planen und offline-sicher durchführen, Ergebnisse diagnostisch auswerten und vergleichen sowie einen freigegebenen deutsch- oder englischsprachigen Bericht mit dokumentiertem Setup und Recovery erzeugen kann, ohne dass ein explizites MVP-Release-Gate offen bleibt.

## Ergebnis

**87 % — noch nicht Beta.**

| Dimension | Punkte |
|---|---:|
| Kernnutzen und Scope | 20/20 |
| Vertikaler End-to-End-Pfad | 18/20 |
| Daten, Fehlerfälle und Wiederaufnahme | 13/15 |
| Verifikation | 20/20 |
| Bedienbarkeit und Deployment | 10/15 |
| Beta-Betrieb und Anleitung | 6/10 |
| **Gesamt** | **87/100** |

## Evidenz

- Athleten, Einwilligungen, Protokollplanung, Offline-Testdurchführung, Qualitätsmodell, Diagnostik und Trainingszonen sind abgeschlossen.
- Browser-E2E belegt Live-Test, Dexie-Persistenz, Browser-Neustart und Sync-Retry ohne Datenverlust.
- Mehrtestvergleich und Vergleichbarkeitsklassifikation sind umgesetzt und browserseitig nachgewiesen.
- Berichtsversionen sind append-only und auf Datenbankebene gegen UPDATE/DELETE abgesichert.
- Der zweisprachige Report-Dokumentkern und ein deterministischer DE/EN-PDF-Renderer sind gemergt; PR #97 war in CI Run #260 grün.
- Tenant-/Rollen-Policy-Tests und Algorithmus-Referenztests sind als Release-Gates erfüllt.

## Harte Beta-Blocker

1. WCAG-2.2-AA-Kernprüfungen sind noch offen.
2. Der Export-/Import-Roundtrip ist noch nicht vollständig.
3. Backup und Restore wurden noch nicht praktisch getestet.
4. Deutsch- und englischsprachige Berichte sind als Release-Gate noch nicht freigegeben; der Renderer existiert, aber der vollständige Benutzer-/Downloadpfad fehlt noch.

## Nicht als Beta-Blocker gewertet

- vollständiges Athleten-Dashboard,
- Clerk-Adapter für SaaS,
- Bluetooth-/PM5-/RP3-Funktionen,
- spätere umfassende Datenschutz-, Export- und Betriebsfeatures außerhalb des kleinsten Beta-Scope.

## UI-Prototyp

**Derzeit nicht empfohlen.** Die verbleibenden Beta-Risiken sind überwiegend Betriebs-, Portabilitäts- und Release-Gates. Ein UI-Wegwerfprototyp würde diese Blocker aktuell nicht ausreichend reduzieren.

## Nächste Schritte

1. DE/EN-PDF-Renderer als tenant-sicheren Report-Download-/Persistenzpfad integrieren und das Bericht-Release-Gate schließen.
2. Minimalen atomaren Export-/Import-Roundtrip für den Beta-Scope implementieren und verifizieren.
3. Betriebs-Release-Slice aus produktivem Docker-Smoke, praktischem Backup/Restore-Drill und WCAG-2.2-AA-Kernprüfung abschließen.
