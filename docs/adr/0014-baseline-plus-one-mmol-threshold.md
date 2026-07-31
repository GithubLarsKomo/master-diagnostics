# ADR 0014: Basis-plus-1-mmol-Methode

## Status

Akzeptiert

## Kontext

Die Methode bestimmt einen Zielwert genau 1 mmol/L oberhalb eines separat festgelegten Basislaktats. Der Basiswert darf nicht still aus beliebigen Stufenwerten abgeleitet werden, weil Ruhewert, erster Belastungswert und niedrigster Messwert nicht gleichbedeutend sind.

## Entscheidung

`packages/diagnostics` stellt `calculateBaselinePlusOneThreshold(points, baselineLactate)` bereit.

Der Algorithmus verlangt einen expliziten, endlichen und nicht negativen Basiswert, setzt den Zielwert auf `baselineLactate + 1`, verwendet nur eingeschlossene exakte Messpunkte, ignoriert Grenzwert-Qualifier als Stützpunkte, übernimmt einen eindeutigen exakten Treffer direkt und interpoliert andernfalls zwischen genau einem aufsteigenden Wertepaar. Herzfrequenz wird nur interpoliert, wenn beide Stützpunkte einen Wert enthalten. Extrapolation und stille Rundung sind verboten. Mehrfachkreuzungen, doppelte Leistungsstufen und mehrdeutige exakte Treffer führen zu einem sichtbaren Fehler.

Die Kennung lautet `baseline-plus-one-mmol`, die Version `1.0.0`.

## Folgen

Die Herkunft des Basiswertes bleibt explizit und auditierbar. Die spätere UI muss Herkunft und Zeitpunkt des Basiswertes anzeigen. Ergebnis-Hash, Modellgüte und Trainerfreigabe bleiben Folgeinkremente.
