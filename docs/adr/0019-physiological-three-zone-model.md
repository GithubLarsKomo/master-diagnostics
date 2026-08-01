# ADR 0019: Physiologisches Drei-Zonen-Modell als versionierter Fachvertrag

## Status

Angenommen

## Kontext

Nach Abschluss des diagnostischen Fachkerns sollen aus einer explizit ausgewählten LT1- und LT2-Konstellation belastbare Trainingsbereiche abgeleitet werden. Die Software darf fehlende oder widersprüchliche Schwellen nicht stillschweigend ersetzen und muss Grenzfälle deterministisch behandeln.

## Entscheidung

Das physiologische Drei-Zonen-Modell wird als versionierter Fachvertrag `physiological-three-zone-v1` modelliert.

Der Vertrag erhält:

- eine LT1-Grenze,
- eine LT2-Grenze,
- eine explizite Einheit,
- die Hash-Referenz auf die zugrunde liegende Trainerentscheidung,
- optionale fachliche Warnungen.

Für Version 1 gelten folgende Bereiche:

- **Zone 1:** Intensität kleiner oder gleich LT1,
- **Zone 2:** Intensität größer LT1 und kleiner oder gleich LT2,
- **Zone 3:** Intensität größer LT2.

Zusätzlich gelten folgende Invarianten:

- LT1 und LT2 müssen endlich und positiv sein,
- LT1 muss strikt kleiner als LT2 sein,
- beide Schwellen müssen dieselbe Einheit verwenden,
- die Trainerentscheidung muss über einen gültigen SHA-256-Hash referenziert werden,
- Grenzwerte werden nicht gerundet oder automatisch korrigiert,
- Warnungen werden normalisiert, dedupliziert und unverändert mitgeführt,
- die Ausgabe ist unveränderlich und enthält die Schema-Version.

Der Vertrag erzeugt keine Fünf-Zonen-Regel, keine Herzfrequenzzonen und keine Trainerkorrektur. Diese folgen in getrennten Inkrementen.

## Folgen

Das Drei-Zonen-Modell kann unabhängig von UI und Persistierung getestet werden. Die eindeutige Behandlung von LT1 und LT2 verhindert überlappende oder unbestimmte Bereiche. Nachgelagerte Zonenmodelle können die gleiche ausgewählte diagnostische Entscheidung referenzieren, ohne Schwellenwerte neu zu interpretieren.
