# ADR-0007: Einmaliger Club-Bootstrap

## Status
Accepted

## Entscheidung
Im `club`-Deployment darf genau ein Tenant existieren. Solange kein Tenant vorhanden ist, leitet die Anwendung auf `/setup` um. Der Assistent erzeugt zuerst die lokale Better-Auth-Identität und anschließend in einer libSQL-Transaktion Tenant, Domain-Nutzer, Identitätsverknüpfung, Tenant-Admin-Mitgliedschaft und Audit-Ereignis.

## Konsequenzen
- Der Setup-Assistent sperrt sich nach erfolgreicher Einrichtung selbst.
- Ein zweiter Tenant kann im Club-Modus nicht über die Anwendung erzeugt werden.
- Fehler nach der Auth-Anlage, aber vor dem Domain-Bootstrap, müssen administrativ bereinigt werden; ein späterer Recovery-CLI-Befehl ist Teil des nächsten Betriebs-Epics.
