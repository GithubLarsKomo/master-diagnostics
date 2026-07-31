# ADR 0013: Fixe 2-/4-mmol-Laktatschwellen

## Status

Akzeptiert

## Kontext

Die fixe Laktatmethode bestimmt LT1 bei 2 mmol/L und LT2 bei 4 mmol/L. Sie ist einfach, reproduzierbar und als Referenzmethode geeignet, darf aber weder ausgeschlossene noch zensierte Messwerte wie exakte Werte behandeln und darf fehlende Messbereiche nicht extrapolieren.

## Entscheidung

`packages/diagnostics` stellt `calculateFixedLactateThresholds(points)` bereit.

Der Algorithmus:

- verwendet ausschließlich eingeschlossene Punkte,
- verwendet ausschließlich exakte Laktatwerte; `LESS_THAN` und `GREATER_THAN` werden verworfen,
- sortiert die verbleibenden Punkte nach Leistung,
- übernimmt einen exakt gemessenen Zielwert direkt,
- interpoliert ansonsten zwischen genau einem aufsteigenden Wertepaar, das 2 beziehungsweise 4 mmol/L umklammert,
- interpoliert die Herzfrequenz nur, wenn sie an beiden Stützpunkten vorhanden ist,
- extrapoliert niemals,
- lehnt mehrdeutige Mehrfachkreuzungen, doppelte Leistungsstufen und mehrfach exakt gemessene Zielwerte sichtbar ab,
- rundet Ergebnisse nicht.

Die Methode trägt die stabile Kennung `fixed-lactate-2-4-mmol` und die Algorithmusversion `1.0.0`.

## Folgen

- LT1 und LT2 sind mit denselben geprüften Interpolationsregeln reproduzierbar.
- Qualitätsstatus und Qualifier beeinflussen nachvollziehbar die Punktmenge.
- Nicht monotone Messfolgen führen bei mehrdeutigen Kreuzungen zu einem Fehler statt zu einer stillen Auswahl.
- Darstellung, fachliche Freigabe, Ergebnis-Hash und Trainerentscheidung bleiben Folgeinkremente.
