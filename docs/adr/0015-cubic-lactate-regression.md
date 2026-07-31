# ADR 0015: Kubische Laktatregression

## Status

Akzeptiert

## Kontext

Die kubische Regression soll eine glatte Laktat-Leistungs-Kurve als Grundlage für spätere Schwellenmethoden liefern. Ein Regressionsmodell darf jedoch keine Qualitätsentscheidung ersetzen, zensierte Werte als exakte Messungen behandeln oder außerhalb des gemessenen Leistungsbereichs unbemerkt diagnostische Aussagen erzeugen.

## Entscheidung

`packages/diagnostics` stellt `fitCubicLactateRegression(points)` bereit. Das erste Inkrement passt ein Polynom dritten Grades mittels kleinster Quadrate an mindestens vier eingeschlossene, exakte Messpunkte an.

Zur numerischen Stabilität werden Leistungswerte vor der Anpassung zentriert und auf den beobachteten Bereich skaliert. Das Ergebnis enthält Koeffizienten im normalisierten Koordinatensystem, Zentrum und Skalierung, Punktzahl, R², RMSE, Algorithmuskennung und Version sowie eine reine Vorhersagefunktion.

Sicherheitsgrenzen:

- nur eingeschlossene Messpunkte mit `EXACT` oder ohne Qualifier,
- mindestens vier unterschiedliche, endliche Leistungswerte,
- sichtbarer Fehler bei singulärer Matrix oder ungültigen Eingaben,
- keine stille Rundung,
- Modellgüte wird als R² und RMSE ausgegeben,
- R² unter 0,90 erzeugt `LOW_MODEL_FIT`, führt aber nicht zu einer automatischen fachlichen Freigabe oder Ablehnung,
- dieses Inkrement bestimmt noch keine Schwelle und invertiert die Kurve nicht,
- spätere Schwellenberechnung darf nur innerhalb des gemessenen Leistungsbereichs erfolgen.

Die Kennung lautet `cubic-lactate-regression`, die Version `1.0.0`.

## Folgen

Die Kurvenanpassung ist deterministisch und separat referenztestbar. Schwelleninversion, Dmax, Monotonieprüfung, Ergebnis-Hash und Trainerentscheidung bleiben getrennte Folgeinkremente. Ein unabhängiger Python-Referenzdatensatz wird vor Freigabe des Algorithmus-Gates ergänzt.
