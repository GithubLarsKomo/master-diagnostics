# WCAG 2.2 AA — Club-Beta-Kernprüfung

Status: **Gate offen**

Diese Checkliste ergänzt die automatisierten Browser-Contracts unter `apps/web/e2e/`. Ein grüner automatisierter Lauf allein schließt das Release-Gate nicht.

## Automatisierte Evidence

Die Browser-Contracts prüfen auf dem realen Club-E2E-Lebenszyklus und den stabil erreichbaren Club-Beta-Oberflächen:

- uninitialisiertes Club-Setup vor Bootstrap (`/setup`),
- Sign-in nach kontrolliertem Logout (`/sign-in`), einschließlich abgewiesener Zugangsdaten als verständlicher `role="alert"`-Fehlerzustand ohne Verlassen der Loginseite,
- Trainer-Startseite, Athletenliste, Testliste und vorhandene Testdetail-/Review-Oberfläche,
- programmatische Namen für sichtbare Buttons, Links und Formcontrols,
- genau ein `main`-Landmark und genau eine H1,
- keine Übersprünge in der Heading-Hierarchie auf den geschützten Kernoberflächen,
- keine doppelten DOM-IDs,
- keine positiven `tabindex`-Werte,
- kein `img` ohne `alt`-Attribut,
- WCAG-AA-Textkontrast aus den tatsächlich berechneten Browserfarben: mindestens 4.5:1 für normalen Text und mindestens 3:1 für großen beziehungsweise ausreichend fetten Text,
- Keyboard-Fokus bewegt sich über mehrere Bedienelemente,
- mindestens ein sichtbarer Browser-/CSS-Fokusindikator,
- kein seitenweiter horizontaler Overflow bei 320 CSS px,
- WCAG 1.4.12 Text Spacing mit 1.5 line-height, 2em paragraph spacing, 0.12em letter spacing und 0.16em word spacing ohne seitenweiten Overflow oder abgeschnittenen Text in `overflow:hidden/clip`-Containern.

## Manuelle Pflichtprüfung vor Gate-Schluss

Die folgenden Punkte sind für den realen Trainer-Kernpfad manuell in einem aktuellen Chromium-Build zu prüfen und mit Datum, Commit-SHA und Ergebnis zu dokumentieren:

1. **Setup und Sign-in**
   - vollständige Bedienung ausschließlich per Tastatur,
   - sichtbare Fokusreihenfolge logisch,
   - automatisierter Sign-in-Fehlerzustand ist grün; manuell verbleibt die Gegenprüfung, dass die Fehlermeldung mit Screenreader verständlich und zum Formular passend angekündigt wird.
2. **Trainer-Startseite und Navigation**
   - Landmark-/Heading-Struktur mit Screenreader-Schnellnavigation plausibel,
   - Fokus geht beim Seitenwechsel nicht verloren oder an eine unerwartete Stelle.
3. **Athletenverwaltung und Testplanung**
   - Labels/Descriptions werden von Screenreader korrekt angesagt,
   - Pflicht-/Fehlerzustände nicht ausschließlich über Farbe vermittelt.
4. **Sicherheitscheck und Live-Test**
   - Checkliste, Start/Pause/Fortsetzen/Abbruch vollständig keyboardbedienbar,
   - Timer-, Warn- und Sync-Status werden semantisch verständlich vermittelt,
   - keine Keyboard-Trap.
5. **Datenreview/Korrektur**
   - Tabellen-/Formstruktur verständlich,
   - Korrektur-, Ausschluss- und Fehlermeldungen ohne Farbwissen nutzbar.
6. **Ergebnis, Vergleich und Report**
   - Diagramme besitzen eine äquivalente textuelle/strukturierte Information,
   - Download-/Sprachwahl per Tastatur nutzbar.
7. **Kontrast-Gegenprüfung**
   - automatisierter Textkontrast ist auf aktuellem `main` grün,
   - wesentliche nicht-textliche UI-Komponenten und Fokusindikatoren besitzen mindestens 3:1 gegen angrenzende Farben,
   - Zustände/Informationen werden nicht ausschließlich über Farbunterschiede vermittelt.
8. **Zoom/Reflow**
   - Browserzoom 200 % ohne Informations-/Funktionsverlust,
   - automatisierter 320-CSS-px-Reflow ist grün; manuell verbleibt die Gegenprüfung bei 400 % inklusive fachlich notwendiger Datentabellen.
9. **Textabstände**
   - automatisierter WCAG-1.4.12-Text-Spacing-Contract ist grün,
   - manuelle visuelle Gegenprüfung bestätigt keinen Informationsverlust und keine Überlagerung im vollständigen Trainerpfad.
10. **Statusmeldungen**
   - Offline/Sync, Validierung, Speichern, Report-Erzeugung und Fehlerzustände werden ohne Fokusverschiebung assistiv erkennbar.

## Evidence-Protokoll

Vor Schließen des Release-Gates hier ergänzen:

- Commit-SHA: `TBD`
- Browser/Version: `TBD`
- Prüfer: `TBD`
- Datum: `TBD`
- Setup/Sign-in: `TBD`
- Trainer/Navigation: `TBD`
- Athleten/Testplanung: `TBD`
- Live-Test: `TBD`
- Datenreview: `TBD`
- Ergebnis/Vergleich/Report: `TBD`
- Kontrast-Gegenprüfung: `TBD`
- Zoom/Reflow: `TBD`
- Textabstände: `TBD`
- Statusmeldungen: `TBD`
- Abweichungen: `TBD`

## Gate-Regel

`TASKS.md` darf erst auf `[x] WCAG-2.2-AA-Kernprüfungen bestehen` gesetzt werden, wenn die automatisierten Browser-Contracts auf aktuellem `main` grün sind und alle manuellen Pflichtpunkte oben mit `PASS` oder einer explizit begründeten, nicht beta-kritischen Ausnahme dokumentiert wurden.

Related: #276
