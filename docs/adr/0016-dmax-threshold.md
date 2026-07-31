# ADR 0016: Dmax-Schwelle auf kubischer Regression

## Status

Akzeptiert

## Kontext

Das klassische Dmax-Verfahren bestimmt auf einer geglätteten Laktat-Leistungs-Kurve den Punkt mit dem größten senkrechten Abstand zur Geraden zwischen dem ersten und letzten verwendbaren Messpunkt. Der Suchraum und die verwendeten Endpunkte müssen explizit begrenzt sein, damit keine diagnostische Extrapolation entsteht.

## Entscheidung

`packages/diagnostics` stellt `calculateDmaxThreshold(points)` bereit.

Der Algorithmus:

- verwendet nur eingeschlossene Messpunkte mit exaktem Laktatwert,
- benötigt mindestens vier unterschiedliche Leistungsstufen,
- passt die versionierte kubische Regression aus ADR 0015 an,
- verwendet den ersten und letzten verwendbaren Messpunkt als Endpunkte der Referenzgeraden,
- begrenzt die Suche strikt auf den gemessenen Leistungsbereich,
- bildet die kubische Differenz zwischen Regressionskurve und Referenzgerade,
- prüft deterministisch beide Intervallgrenzen und alle inneren reellen Nullstellen ihrer Ableitung,
- wählt den Kandidaten mit dem größten absoluten senkrechten Abstand; bei Gleichstand den niedrigeren Leistungswert,
- rundet das Ergebnis nicht,
- übernimmt Warnungen der Regression,
- meldet eine Randlagenwarnung innerhalb von 1 % der Intervallgrenze,
- meldet eine Warnung bei vernachlässigbarem Maximalabstand.

Die Kennung lautet `dmax-cubic`, die Version `1.0.0`.

## Sicherheitsgrenzen

- Es findet keine Extrapolation außerhalb des ersten und letzten verwendbaren Messpunkts statt.
- Die Suche setzt keine Unimodalität der absoluten Distanzfunktion voraus.
- Zensierte und ausgeschlossene Werte beeinflussen weder Regression noch Referenzgerade.
- Dmax ist eine algorithmische Schätzung und keine automatische fachliche Freigabe.
- Eine schlechte Regressionsgüte bleibt als Warnung sichtbar.
- Das modifizierte Dmax benötigt eine eigene fachliche Definition und ein separates ADR.

## Folgen

Dmax kann reproduzierbar berechnet und referenzgetestet werden. Unabhängige Python-Gegenrechnung, deterministische Ergebnis-Hashes und Trainerentscheidung bleiben Folgeinkremente.
