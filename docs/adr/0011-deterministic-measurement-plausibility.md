# ADR 0011: Deterministische Plausibilitätswarnungen für Messfolgen

## Status

Akzeptiert

## Kontext

Messwerte können formal gültig und dennoch fachlich auffällig sein. Solche Auffälligkeiten dürfen weder still korrigiert noch automatisch ausgeschlossen werden, weil Probenfehler, Übertragungsfehler, physiologische Besonderheiten und zulässige Grenzwertangaben fachlich unterschiedlich zu bewerten sind.

## Entscheidung

Die Anwendung verwendet eine frameworkunabhängige, deterministische Regelbewertung im Domain-Paket. Sie erzeugt ausschließlich Hinweise und verändert weder Messwerte noch Qualitätsstatus.

Die erste Regelmenge erkennt:

- Abfall eines exakten Laktatwerts um mindestens 0,50 mmol/L gegenüber der vorherigen eingeschlossenen Stufe,
- Abfall der Herzfrequenz um mindestens 10 Schläge/min gegenüber der vorherigen eingeschlossenen Stufe,
- eingeschlossene Stufen ohne Laktat- und Herzfrequenzwert,
- Laktatwerte mit `LESS_THAN` oder `GREATER_THAN` als zensierte Grenzwerte, die bei Trend- und Schwellenverfahren besonders behandelt werden müssen.

`EXCLUDED`- und `MISSING`-Stufen werden nicht als Vergleichspunkte verwendet. Grenzwert-Qualifier lösen nur einen informativen Hinweis aus und werden nicht wie exakte Werte in monotone Laktatvergleiche einbezogen.

## Folgen

- Die Regeln sind reproduzierbar und unabhängig von UI, Datenbank und späteren Diagnostikmodellen testbar.
- Warnungen sind fachliche Review-Hilfen, keine automatische Diagnose oder Ausschlussentscheidung.
- Schwellenwerte sind bewusst konservative Startwerte und müssen bei Änderung über eine ADR-Anpassung versioniert werden.
- Ein Folgeinkrement integriert die Warnungen in die Datenprüfung und dokumentiert die Trainerentscheidung zu relevanten Warnungen.
