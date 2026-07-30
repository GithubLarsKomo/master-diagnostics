# ADR 0010: Automatische Qualitätsklassifikation verkürzter Stufen

## Status

Akzeptiert

## Entscheidung

Beim Übergang von `IN_PROGRESS` nach `DATA_REVIEW` übermittelt der lokale
Timer seine aktive Laufzeit ohne Pausenzeiten. Der Server prüft diese gegen
Teststart und unveränderlichen Testplan und berechnet daraus für jede bereits
vorhandene Stufenmessung die tatsächlich absolvierte Dauer.

Die im Plan-Snapshot eingefrorene Einschlussgrenze bestimmt den automatischen
Qualitätsstatus:

- vollständige Soll-Dauer: `VALID`
- verkürzt, aber mindestens an der Einschlussgrenze: `PARTIAL`
- verkürzt und unterhalb der Einschlussgrenze: `EXCLUDED`

Die Werksprotokolle verwenden die spezifizierte Grenze von 50 Prozent.
Nicht begonnene oder nicht erfasste Stufen bleiben `MISSING`. Die berechnete
Dauer und die Statusänderung werden gemeinsam mit dem Testabschluss im
Audit-Ereignis dokumentiert.

## Folgen

- Pausen verfälschen die tatsächlich absolvierte Stufendauer nicht.
- Die Schwelle stammt aus dem unveränderlichen Plan und kann nach Teststart
  nicht rückwirkend geändert werden.
- Trainer können einen automatischen Ausschluss oder Einschluss anschließend
  in `DATA_REVIEW` mit Pflichtbegründung überschreiben.
- Die Nachbearbeitung zeigt Ist- und Soll-Dauer jeder vorhandenen Stufe.
- Eine serverseitige Live-Synchronisation des vollständigen Timerzustands
  bleibt außerhalb dieses Inkrements.
