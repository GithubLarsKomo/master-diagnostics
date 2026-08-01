# ADR 0020: Versionierte Fünf-Zonen-Regel aus LT1 und LT2

## Status

Angenommen

## Kontext

Das physiologische Drei-Zonen-Modell bildet die Bereiche unterhalb LT1, zwischen LT1 und LT2 sowie oberhalb LT2 ab. Für die Trainingssteuerung wird zusätzlich eine feinere, reproduzierbare Fünf-Zonen-Regel benötigt. Diese darf die diagnostischen Schwellen nicht verändern und muss ihre Grenzen transparent aus LT1 und LT2 ableiten.

## Entscheidung

Die Fünf-Zonen-Regel wird als versionierter Fachvertrag `threshold-five-zone-v1` modelliert.

Der Vertrag erhält:

- LT1 und LT2 mit gemeinsamer expliziter Einheit,
- die Hash-Referenz auf die zugrunde liegende Trainerentscheidung,
- die vier abgeleiteten Zonengrenzen,
- optionale fachliche Warnungen.

Für Version 1 gelten die Standardgrenzen:

- Grenze 1: 85 % von LT1,
- Grenze 2: LT1,
- Grenze 3: 95 % von LT2,
- Grenze 4: 102 % von LT2.

Die Zonen werden deterministisch zugeordnet:

- **Zone 1:** Intensität kleiner oder gleich Grenze 1,
- **Zone 2:** Intensität größer Grenze 1 und kleiner oder gleich LT1,
- **Zone 3:** Intensität größer LT1 und kleiner oder gleich 95 % LT2,
- **Zone 4:** Intensität größer 95 % LT2 und kleiner oder gleich 102 % LT2,
- **Zone 5:** Intensität größer 102 % LT2.

Zusätzlich gelten folgende Invarianten:

- LT1 und LT2 müssen endlich, positiv und strikt geordnet sein,
- die vier Grenzen müssen nach der Berechnung strikt aufsteigend sein,
- die Eingabeschwellen und berechneten Grenzen werden nicht gerundet,
- die Trainerentscheidung wird über einen gültigen SHA-256-Hash referenziert,
- Warnungen werden normalisiert und dedupliziert,
- die Ausgabe ist unveränderlich und enthält die Schema-Version.

Falls 95 % von LT2 nicht oberhalb von LT1 liegt, ist der Vertrag nicht anwendbar und muss sichtbar fehlschlagen. Es erfolgt keine automatische Anpassung der Prozentsätze.

Der Vertrag erzeugt noch keine Herzfrequenzzonen, keine HFmax-abhängige Obergrenze und keine Trainerkorrektur. Diese folgen in getrennten Inkrementen.

## Folgen

Die Standardregel bleibt auditierbar und reproduzierbar. Unplausibel nahe Schwellen werden nicht durch stille Korrekturen kaschiert. Nachgelagerte Versionen können abweichende Prozentgrenzen einführen, ohne bestehende Ergebnisse umzudeuten.
