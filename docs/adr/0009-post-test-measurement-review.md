# ADR 0009: Versionierte Messwertnachbearbeitung

## Status

Akzeptiert

## Entscheidung

Messwerte können nach Testende zunächst ausschließlich im Zustand
`DATA_REVIEW` tabellarisch ergänzt oder korrigiert werden. Jede Speicherung
enthält die erwartete Datensatzversion und einen Pflichtvermerk. Weicht die
Version vom Serverstand ab, wird der aktuelle Serverstand als Konflikt
zurückgegeben und der Entwurf nicht überschrieben.

Die bestehende aktuelle Messwertzeile bleibt die operative Datenquelle. Ihre
vollständigen Zustände vor und nach jeder Änderung werden zusammen mit Nutzer,
Rolle, Zeitpunkt und Begründung im append-only Audit-Log gespeichert. Eine
zusätzliche Korrekturtabelle ist deshalb für dieses Inkrement nicht
erforderlich.

Stufen verwenden die Status `VALID`, `PARTIAL`, `EXCLUDED`, `MISSING` und
`MANUALLY_CORRECTED`. Eine nachträgliche Änderung von Messwert oder
Messzeitpunkt setzt den Status automatisch auf `MANUALLY_CORRECTED`.
`EXCLUDED` und `MISSING` bleiben als bewusst gewählte fachliche Zustände
vorrangig. Ausschluss und Wiedereinschluss benötigen ebenfalls eine
Begründung und erzeugen eine neue Version.

## Folgen

- Kein Online-Bearbeiter kann einen parallel geänderten Stand still
  überschreiben.
- Ursprungswert, neuer Wert und Begründung bleiben revisionsfähig erhalten.
- Bereits interpretierte oder freigegebene Tests werden noch nicht verändert;
  deren Invalidierungs- und Neufreigabeworkflow folgt in einem späteren
  Inkrement.
- Automatische Plausibilitätsprüfungen und die Teilstufenregel bleiben
  unabhängig von der manuellen Tabellenbearbeitung.
