# ADR 0012: Vertrag für lineare Interpolation

## Status

Akzeptiert

## Kontext

Mehrere diagnostische Modelle müssen aus zwei benachbarten Messpunkten die Leistung zu einem Ziel-Laktatwert bestimmen. Diese Grundoperation muss reproduzierbar, modellunabhängig und frei von stiller Extrapolation oder Rundung sein.

## Entscheidung

`packages/diagnostics` stellt mit `interpolateX(x1, y1, x2, y2, targetY)` eine reine lineare Interpolation bereit.

Der Vertrag lautet:

- alle Eingaben müssen endliche Zahlen sein,
- die beiden y-Werte müssen verschieden sein,
- der Zielwert muss einschließlich der Grenzen zwischen den beiden y-Werten liegen,
- auf- und absteigende y-Reihen werden unterstützt,
- Grenzwerte liefern exakt den zugehörigen x-Endpunkt,
- die Funktion rundet nicht; modell- oder darstellungsspezifische Rundung erfolgt erst beim Verbraucher,
- Extrapolation ist ausdrücklich verboten.

Die Funktion verwendet:

```text
x = x1 + (targetY - y1) / (y2 - y1) * (x2 - x1)
```

## Folgen

- Die fixe 2-/4-mmol-Methode und Basis-plus-1 können denselben geprüften Kern verwenden.
- Fehlerhafte flache Segmente und Ziele außerhalb des Messintervalls werden früh und sichtbar abgelehnt.
- Referenztests sichern steigende und fallende Reihen, Endpunkte, Dezimalergebnisse und Fehlerfälle.
- Eine spätere Methode muss ihre Auswahl der beiden Stützpunkte und ihre Rundungsregel separat dokumentieren.
