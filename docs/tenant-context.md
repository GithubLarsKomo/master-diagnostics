# Tenant-Kontext und Autorisierung

## Vertrauensgrenze

Der Tenant-Kontext wird ausschließlich im Next.js-Proxy aus der authentifizierten Better-Auth-Session und einer aktiven Tenant-Mitgliedschaft erzeugt. Vom Client gelieferte Header mit den Namen `x-masters-tenant-id`, `x-masters-user-id`, `x-masters-role`, `x-masters-auth-provider` und `x-masters-session-id` werden vor der internen Belegung entfernt.

Anwendungscode darf Tenant, Benutzer, Rolle, Auth-Provider oder Sitzungskennung nicht aus Formularfeldern, Query-Parametern oder unbereinigten Request-Headern übernehmen.

Die Sitzungskennung ist die interne Session-ID des Auth-Providers und nicht dessen Session-Token. Sie dient der revisionssicheren Zuordnung von Audit-Ereignissen, ohne ein Authentifizierungsgeheimnis im Audit-Log zu speichern.

## Autorisierungsreihenfolge

1. Session validieren.
2. Aktive Mitgliedschaft auflösen.
3. Vertrauenswürdigen Request-Kontext inklusive Auth-Provider und Session-ID erzeugen.
4. Tenant-Zugehörigkeit der Ressource prüfen.
5. Rollen-Capability prüfen.
6. Erst danach Daten lesen oder verändern.

`PLATFORM_ADMIN` darf tenantübergreifend prüfen, benötigt aber weiterhin die jeweilige Capability. Alle anderen Rollen werden bei abweichender Tenant-ID abgewiesen.

## Verwendung

Server Components und Server Actions lesen den Kontext über `getTenantContext()`. Fachservices verwenden `authorize(context, capability, resourceTenantId)` vor jedem tenantbezogenen Zugriff.

Audit-fähige Mutationen können `authProvider` und `sessionId` zusätzlich zum fachlichen Actor an den zentralen Audit-Service weiterreichen. Die Athlete-Mutationen dienen als erster end-to-end abgesicherter Pfad; weitere Writer werden schrittweise nach demselben Muster migriert.

## Tests

Die Domain-Tests decken die vollständige Rollenmatrix, Cross-Tenant-Ablehnung, erfolgreiche In-Tenant-Autorisierung und die Kombination aus Tenant- und Capability-Prüfung ab. DB-Tests prüfen zusätzlich, dass Audit-Ereignisse den weitergereichten Auth-Provider und die Session-ID speichern. Der Playwright-Test durchläuft eine frische Club-Einrichtung, die Anmeldung des ersten Tenant-Admins und die Sperre einer erneuten Einrichtung.
