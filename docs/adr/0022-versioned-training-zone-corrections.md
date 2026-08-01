# ADR 0022: Versionierte Trainerkorrekturen für Trainingszonen

## Status

Angenommen

## Kontext

Die diagnostisch abgeleiteten Drei-Zonen-, Fünf-Zonen- und Herzfrequenzmodelle sind deterministisch und unveränderlich. Trainer müssen begründete Anpassungen vornehmen können, ohne den ursprünglichen Vorschlag zu überschreiben oder dessen Herkunft unkenntlich zu machen.

## Entscheidung

Trainerkorrekturen werden als append-only Fachvertrag `training-zone-correction-v1` modelliert.

Jede Korrektur enthält:

- eine eindeutige Korrektur-ID,
- die Schema-Version,
- die SHA-256-Referenz auf das unveränderte Ausgangsmodell,
- die Modellart `PHYSIOLOGICAL_THREE_ZONE`, `THRESHOLD_FIVE_ZONE` oder `THRESHOLD_HEART_RATE_ZONES`,
- eine positive ganzzahlige Versionsnummer,
- den vorherigen Korrektur-Hash oder `null` bei Version 1,
- die vollständig angegebenen korrigierten Grenzen in der Einheit des Ausgangsmodells,
- einen nicht leeren fachlichen Grund,
- die Trainer-ID und den UTC-Zeitstempel,
- optionale normalisierte Warnungen.

Es gelten folgende Invarianten:

- Das Ausgangsmodell bleibt unverändert und weiterhin abrufbar.
- Versionen beginnen bei 1 und steigen ohne Lücken um genau 1.
- Ab Version 2 muss der Hash der unmittelbar vorherigen Korrektur referenziert werden.
- Korrigierte Grenzen müssen positiv, endlich und strikt aufsteigend sein.
- BPM-Grenzen müssen ganzzahlig sein.
- Eine offene obere Herzfrequenzgrenze bleibt als `null` darstellbar; sie darf nicht geschätzt werden.
- Der Grund wird getrimmt und darf danach nicht leer sein.
- Trainer-ID und UTC-Zeitstempel sind Pflichtfelder.
- Die kanonische Nutzlast erhält einen deterministischen SHA-256-Hash.
- Ausgaben sind tief unveränderlich.

Eine Korrektur verändert weder Trainerentscheidung noch diagnostische Schwellen. Sie erzeugt eine neue, nachvollziehbare Trainingszonen-Version. Löschen oder Überschreiben bestehender Versionen ist nicht zulässig.

## Folgen

Die ursprüngliche Berechnung, jede fachliche Anpassung und die vollständige Versionskette bleiben auditierbar. UI, Persistierung und Berechtigungsprüfung folgen in späteren Inkrementen; zunächst wird nur der reine Fachvertrag implementiert und getestet.
