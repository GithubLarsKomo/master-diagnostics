# ADR 0011: Abgeleitete Plausibilitätswarnungen in der Datenprüfung

## Status

Akzeptiert

## Entscheidung

Plausibilitätswarnungen werden in `DATA_REVIEW` deterministisch aus dem
jeweils aktuellen Messwertstand abgeleitet. Sie werden nicht als eigene
Messdaten gespeichert und verändern weder Messwerte noch Qualitätsstatus.
Nach einer versionierten Korrektur berechnet die Oberfläche die Warnungen
sofort neu.

Das erste Regelset enthält ausschließlich Entscheidungen, für die
Spezifikation und vorhandene Daten eine eindeutige Grundlage bieten:

- Laktatabfall bei höherer Leistung
- identische exakte Laktatwerte über aufeinanderfolgende Stufen
- interne Lücke in einer begonnenen Laktatreihe
- Herzfrequenzabfall bei höherer Leistung
- exakter Ruhelaktatwert oberhalb des ersten exakten Belastungswertes
- verkürzte Stufe
- qualifizierte Laktatwerte
- weniger als vier verwendbare exakte Belastungswerte

Explizit ausgeschlossen bleiben zunächst der ungewöhnlich große
Laktatsprung, eine stark abweichende Probenzeit sowie Warnungen aus LT- und
Dmax-Ergebnissen. Dafür fehlen noch versionierte Fachschwellen
beziehungsweise Interpretationsergebnisse; die Anwendung darf keine
medizinischen Grenzwerte erfinden.

## Folgen

- Warnungen sind reproduzierbar und verschwinden, sobald ihre Ursache
  korrigiert oder fachlich ausgeschlossen wird.
- Ein ausgeschlossener Messwert nimmt nicht mehr an Reihenvergleichen teil.
- Warnungen bleiben Hinweise; die bestehenden Traineroptionen zum
  Korrigieren, Ausschließen und Markieren als fehlend bleiben maßgeblich.
- Persistente Bestätigung kritischer Warnungen wird zusammen mit dem
  späteren Freigabeworkflow eingeführt.
