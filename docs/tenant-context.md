# Tenant-Kontext und Autorisierung

## Vertrauensgrenze

Der Tenant-Kontext wird ausschließlich im Next.js-Proxy aus der authentifizierten Better-Auth-Session und einer aktiven Tenant-Mitgliedschaft erzeugt. Vom Client gelieferte Header mit den Namen `x-masters-tenant-id`, `x-masters-user-id` und `x-masters-role` werden vor der internen Belegung entfernt.

Anwendungscode darf Tenant, Benutzer oder Rolle nicht aus Formularfeldern, Query-Parametern oder unbereinigten Request-Headern übernehmen.

## Autorisierungsreihenfolge

1. Session validieren.
2. Aktive Mitgliedschaft auflösen.
3. Vertrauenswürdigen Request-Kontext erzeugen.
4. Tenant-Zugehörigkeit der Ressource prüfen.
5. Rollen-Capability prüfen.
6. Erst danach Daten lesen oder verändern.

`PLATFORM_ADMIN` darf tenantübergreifend prüfen, benötigt aber weiterhin die jeweilige Capability. Alle anderen Rollen werden bei abweichender Tenant-ID abgewiesen.

## Verwendung

Server Components und Server Actions lesen den Kontext über `getTenantContext()`. Fachservices verwenden `authorize(context, capability, resourceTenantId)` vor jedem tenantbezogenen Zugriff.

## Tests

Die Domain-Tests decken die vollständige Rollenmatrix, Cross-Tenant-Ablehnung, erfolgreiche In-Tenant-Autorisierung und die Kombination aus Tenant- und Capability-Prüfung ab. Der Playwright-Test durchläuft eine frische Club-Einrichtung, die Anmeldung des ersten Tenant-Admins und die Sperre einer erneuten Einrichtung.
