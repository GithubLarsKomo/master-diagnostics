# ADR 0015: Kubische Laktatregression

## Status

Akzeptiert

## Kontext

Dmax und verwandte Verfahren benötigen eine glatte Approximation der Laktat-Leistungs-Kurve. Die Regression muss reproduzierbar sein, ihre Modellgüte offenlegen und darf ausgeschlossene oder zensierte Werte nicht wie exakte Messwerte behandeln.

## Entscheidung

`packages/diagnostics` stellt `fitCubicLactateRegression(points)` bereit.

Der Algorithmus:

- verwendet ausschließlich eingeschlossene exakte Messpunkte,
- verlangt mindestens vier Punkte mit unterschiedlichen Leistungswerten,
- zentriert und skaliert die Leistung vor dem Fit zur numerischen Stabilisierung,
- bestimmt die vier Koeffizienten mittels kleinster Quadrate und partieller Pivotisierung,
- stellt eine reine Vorhersagefunktion für Laktat bei gegebener Leistung bereit,
- berechnet `R²`, RMSE und die Anzahl verwendeter Punkte,
- kennzeichnet einen exakt durch vier Punkte bestimmten Fit mit `EXACT_FOUR_POINT_FIT`,
- kennzeichnet `R² < 0,90` mit `LOW_R_SQUARED`,
- extrapoliert nicht automatisch zu einer Schwelle und trifft keine diagnostische Entscheidung.

Die Kennung lautet `cubic-lactate-regression`, die Version `1.0.0`.

## Folgen

- Modellgüte und verwendete Punktmenge sind nachvollziehbar.
- Dmax kann auf einem versionierten und referenzgetesteten Kurvenmodell aufbauen.
- Die spätere Schwellenbestimmung muss ihren Suchbereich auf den gemessenen Leistungsbereich begrenzen.
- Monotonie, physiologische Plausibilität, Ergebnis-Hash und Trainerfreigabe bleiben eigene Folgeinkremente.
