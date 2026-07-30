# ADR 0008: Zeitlich begrenzte Lease für Live-Tests

## Status

Akzeptiert

## Entscheidung

Ein laufender Test besitzt höchstens eine serverseitige Bearbeitungs-Lease.
Die Lease gilt 60 Sekunden und wird vom aktiven Browser alle 20 Sekunden
verlängert. Der Browser erhält einen zufälligen Token; in der Datenbank wird
nur dessen SHA-256-Hash gespeichert. Messwert-Sync und Testabschluss verlangen
eine aktive, zum Bearbeiter und Token passende Lease.

Der Token bleibt für Seitenneuladungen im tabgebundenen `sessionStorage`.
Wird ein Tab geschlossen oder kann er die Lease nicht mehr verlängern, läuft
sie automatisch aus. Eine bewusste Freigabe löscht sie sofort.

Ein zugeordneter Trainer oder Tenant-Admin kann die Bearbeitung mit
Pflichtbegründung übernehmen. Dabei werden Bearbeiter und Token atomar ersetzt,
der ausführende Trainer am Test aktualisiert und die Übernahme auditiert.

## Folgen

- Ein alter Token kann nach Verlängerungsfehler, Ablauf oder Übernahme keine
  Servermutation mehr autorisieren.
- Andere berechtigte Nutzer behalten tenantgebundenen Lesezugriff.
- Offline erfasste Werte bleiben lokal erhalten, werden aber erst mit einer
  erneut gültigen Lease zum Server synchronisiert.
