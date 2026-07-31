# ADR 0015: Kubische Laktatregression

## Status

Akzeptiert

## Kontext

Dmax-basierte Verfahren benötigen eine geglättete Laktat-Leistungs-Kurve. Die Regression muss reproduzierbar sein, die zugrunde liegenden Qualitätsentscheidungen respektieren und ihre Modellgüte sichtbar machen. Sie darf in diesem Inkrement noch keine Schwelle bestimmen oder eine fachliche Freigabe vortäuschen.

## Entscheidung

`packages/diagnostics` stellt `fitCubicLactateRegression(points)` und `predictCubicLactate(model, watts)` bereit.

Der Regressionskern:

- verwendet nur eingeschlossene Messpunkte mit exaktem Laktatwert,
- benötigt mindestens vier verschiedene Leistungsstufen,
- lehnt nicht endliche Werte und doppelte Leistungsstufen ab,
- skaliert die Leistung vor der Anpassung um Mittelwert und maximale Abweichung,
- bestimmt ein Polynom dritten Grades mit kleinsten Quadraten,
- löst das 4×4-Normalgleichungssystem mit partieller Pivotisierung,
- liefert Koeffizienten im skalierten Leistungsraum sowie Skalierungsparameter,
- berechnet Punktzahl, R² und RMSE reproduzierbar,
- meldet `LOW_R_SQUARED`, wenn R² kleiner als 0,95 ist,
- rundet weder Koeffizienten noch Gütemaße still.

Die Kennung lautet `cubic-lactate-least-squares`, die Version `1.0.0`.

## Sicherheitsgrenzen

- Zensierte Werte mit `LESS_THAN` oder `GREATER_THAN` werden nicht als exakte Stützpunkte verwendet.
- Die Regression allein bestimmt weder LT1 noch LT2 und trifft keine diagnostische Entscheidung.
- Vorhersagen außerhalb des gemessenen Leistungsbereichs werden rechnerisch ermöglicht, dürfen aber von späteren Schwellenverfahren nicht ohne eigene dokumentierte Extrapolationsregel genutzt werden.
- R² und RMSE sind technische Anpassungsmaße und ersetzen keine fachliche Plausibilitätsprüfung.
- Numerisch singuläre oder instabile Systeme führen zu einem sichtbaren Fehler.

## Folgen

Die kubische Kurve kann im nächsten Inkrement für Dmax verwendet werden. Dmax muss den zulässigen Suchbereich, die Geometrie der Referenzgeraden, Randfälle und zusätzliche Modellgütewarnungen separat dokumentieren. Python-Gegenrechnung und unveränderliche Referenzdatensätze bleiben ein eigenes Release-Gate.
