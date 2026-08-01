# ADR 0021: Schwellenbasierte Herzfrequenzzonen als versionierter Fachvertrag

## Status

Angenommen

## Kontext

Die leistungsbasierten Drei- und Fünf-Zonen-Modelle sind inzwischen versioniert und deterministisch umgesetzt. Für die Trainingssteuerung werden zusätzlich Herzfrequenzzonen benötigt, die sich an den bei LT1 und LT2 beobachteten Herzfrequenzen orientieren. Dabei darf eine fehlende oder unsichere HFmax nicht durch Schätzung ersetzt werden.

## Entscheidung

Schwellenbasierte Herzfrequenzzonen werden als versionierter Fachvertrag `threshold-heart-rate-zones-v1` modelliert.

Der Vertrag erhält:

- Herzfrequenz an LT1 in BPM,
- Herzfrequenz an LT2 in BPM,
- optional eine gemessene HFmax in BPM,
- die SHA-256-Referenz auf die zugrunde liegende Trainerentscheidung,
- optionale fachliche Warnungen.

Für Version 1 gelten folgende Grenzen:

- **Zone 1:** Herzfrequenz kleiner oder gleich HF an LT1,
- **Zone 2:** Herzfrequenz größer HF an LT1 und kleiner oder gleich HF an LT2,
- **Zone 3:** Herzfrequenz größer HF an LT2 und, sofern HFmax vorhanden ist, kleiner oder gleich HFmax.

Die Zonenbezeichnungen entsprechen bewusst dem physiologischen Drei-Zonen-Modell. Eine feinere fünfstufige Herzfrequenzregel wird nicht implizit aus Leistungsprozenten abgeleitet.

Zusätzlich gelten folgende Invarianten:

- alle vorhandenen Herzfrequenzwerte müssen ganzzahlig, positiv und endlich sein,
- HF an LT1 muss strikt kleiner als HF an LT2 sein,
- eine vorhandene HFmax muss strikt größer als HF an LT2 sein,
- bei fehlender HFmax bleibt die obere Grenze der höchsten Zone offen,
- eine fehlende HFmax wird weder geschätzt noch aus Alter oder Formeln abgeleitet,
- die Trainerentscheidung wird über einen gültigen SHA-256-Hash referenziert,
- Warnungen werden normalisiert und dedupliziert,
- die Ausgabe ist unveränderlich und enthält die Schema-Version.

Der Vertrag klassifiziert nur BPM-Werte. Trainerkorrekturen, alternative Prozentmodelle und altersbasierte HFmax-Schätzungen folgen nicht in dieser Version.

## Folgen

Die Herzfrequenzzonen bleiben direkt an die diagnostisch bestimmten Schwellen gebunden. Bei fehlender HFmax wird die Unsicherheit transparent bewahrt, statt durch eine scheinpräzise Schätzung verdeckt zu werden. Der Vertrag kann unabhängig von UI und Persistierung getestet und später versioniert erweitert werden.
