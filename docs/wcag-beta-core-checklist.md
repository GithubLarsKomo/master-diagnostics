# WCAG 2.2 AA — Club-Beta-Kernprüfung

Status: **Gate offen**

Diese Checkliste ergänzt den automatisierten Browser-Contract `apps/web/e2e/zz-wcag-core.spec.ts`. Ein grüner automatisierter Lauf allein schließt das Release-Gate nicht.

## Automatisierte Evidence

Der Browser-Contract prüft auf den stabil erreichbaren Club-Beta-Oberflächen:

- programmatische Namen für sichtbare Buttons, Links und Formcontrols,
- genau ein `main`-Landmark und genau eine H1,
- keine Übersprünge in der Heading-Hierarchie,
- keine doppelten DOM-IDs,
- keine positiven `tabindex`-Werte,
- kein `img` ohne `alt`-Attribut,
- WCAG-AA-Textkontrast aus den tatsächlich berechneten Browserfarben: mindestens 4.5:1 für normalen Text und mindestens 3:1 für großen beziehungsweise ausreichend fetten Text,
- Keyboard-Fokus bewegt sich über mehrere Bedienelemente,
- mindestens ein sichtbarer Browser-/CSS-Fokusindikator,
- kein seitenweiter horizontaler Overflow bei 320 CSS px,
- Trainer-Startseite, Athletenliste, Testliste und vorhandene Testdetail-/Review-Oberfläche.

## Manuelle Pflichtprüfung vor Gate-Schluss

Die folgenden Punkte sind für den realen Trainer-Kernpfad manuell in einem aktuellen Chromium-Build zu prüfen und mit Datum, Commit-SHA und Ergebnis zu dokumentieren:

1. **Setup und Sign-in**
   - vollständige Bedienung ausschließlich per Tastatur,
   - sichtbare Fokusreihenfolge logisch,
   - Fehlermeldungen verständlich und am Feld/als Status erreichbar.
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
   - Reflow bei 400 % bzw. äquivalent 320 CSS px ohne zweidimensionales Scrollen, ausgenommen fachlich notwendige Datentabellen.
9. **Textabstände**
   - WCAG-Text-Spacing-Override (1.5 line-height, 2x paragraph spacing, 0.12em letter spacing, 0.16em word spacing) ohne Verlust/Überlagerung.
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

`TASKS.md` darf erst auf `[x] WCAG-2.2-AA-Kernprüfungen bestehen` gesetzt werden, wenn der automatisierte Browser-Contract auf aktuellem `main` grün ist und alle manuellen Pflichtpunkte oben mit `PASS` oder einer explizit begründeten, nicht beta-kritischen Ausnahme dokumentiert wurden.

Related: #276
