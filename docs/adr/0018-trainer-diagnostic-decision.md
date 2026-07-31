# ADR 0018: Trainerentscheidung als expliziter, begründeter Fachvertrag

## Status

Angenommen

## Kontext

Mehrere diagnostische Methoden können für denselben Test verfügbare Ergebnisse liefern. Die Software darf daraus nicht stillschweigend eine klinische Entscheidung ableiten. Gleichzeitig muss nachvollziehbar bleiben, welches Ergebnis ein Trainer für die weitere Nutzung ausgewählt hat, welche Alternativen vorlagen und ob Warnungen bewusst berücksichtigt wurden.

## Entscheidung

Die Trainerentscheidung wird als versionierter Fachvertrag `trainer-diagnostic-decision-v1` modelliert.

Der Vertrag:

- verlangt eine explizite Auswahl aus der übergebenen Kandidatenmenge,
- erlaubt nur verfügbare Kandidaten mit gültigem SHA-256-Ergebnishash,
- verlangt eine nicht leere Begründung und einen identifizierbaren Entscheider,
- bewahrt alle nicht ausgewählten Kandidaten als Alternativen,
- verlangt bei Warnungen des ausgewählten Ergebnisses eine ausdrückliche Bestätigung,
- speichert einen gültigen Entscheidungszeitpunkt,
- erzeugt eine unveränderliche Rückgabe.

Die Funktion gibt keine automatische Methodenempfehlung ab und verändert keine diagnostischen Ergebnisse.

## Folgen

Die spätere UI kann eine nachvollziehbare Auswahl anbieten, ohne klinische Verantwortung in eine implizite Rangfolge der Software zu verlagern. Persistierung, Rollenprüfung und Audit-Ereignisse werden in separaten Inkrementen ergänzt.
