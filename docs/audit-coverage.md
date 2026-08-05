# Audit-Coverage gegen SPEC §33

Stand: Epic 10, nach Einführung des append-only Audit-Service und der Auth-/Session-Attribution für die implementierten Fachwriter.

## Grundvertrag

Der zentrale Audit-Service `packages/db/src/services/audit.ts` ist der einzige vorgesehene Schreibpfad für neue Audit-Ereignisse. Die Datenbank verhindert UPDATE und DELETE einzelner Audit-Einträge. Der Actor-Vertrag kann Benutzer, Rolle, Auth-Provider und Sitzungskennung tragen; unbekannte oder nicht authentifizierte Actor-Felder bleiben `NULL` statt erfunden zu werden.

Vertrauensgrenze im Web:

- eingehende interne Context-Header werden im Proxy verworfen,
- Better Auth wird serverseitig ausgewertet,
- Tenant, User, Rolle, Auth-Provider und Session-ID werden daraus neu gesetzt,
- Web-Actions und API-Routen reichen diesen `TenantContext` an Fachwriter weiter.

Besondere Fälle:

- Club-Bootstrap kennt `BETTER_AUTH`, läuft aber vor einem regulären Tenant-Session-Kontext; `session_id` bleibt deshalb `NULL`.
- Der einmalige Tenant-Export-Download ist ein Bearer-Link ohne Session. Das Download-Ereignis wird daher nicht fälschlich dem Export-Ersteller zugerechnet; Actor-, Provider- und Session-Felder bleiben `NULL`.

## Ereignismatrix

| SPEC §33.1 | Status | Implementierter Nachweis / Restlücke |
| --- | --- | --- |
| Login, fehlgeschlagener Login, Logout | offen | Better-Auth-Lifecycle noch nicht in den fachlichen Audit-Service gespiegelt. |
| Rollenänderungen | offen | Rollenverwaltung als auditierter Writer noch nicht umgesetzt. |
| Trainer-Athleten-Zuordnungen | abgedeckt | `athlete.coach_assigned` mit Tenant-/Actor-/Session-Kontext. |
| Einwilligung und Widerruf | abgedeckt | Grant/Withdraw im Consent-Service mit Actor-/Session-Kontext. |
| Testanlage, Start, Unterbrechung, Übernahme, Abbruch | teilweise | Planung, Start, Lock-Übernahme und strukturiertes Testende/Abbruch auditiert; eine serverseitige Unterbrechungs-/Resume-Transition mit eigenem Audit-Ereignis fehlt. |
| Messwertänderungen | abgedeckt | Offline-Sync und nachträgliche Korrektur werden auditiert. |
| Ausschluss/Wiedereinschluss | abgedeckt | Qualitätsstatusänderungen laufen über die auditierte Review-Korrektur mit Pflichtgrund. |
| Bluetooth-Quellenwechsel | abhängig von Epic 11 | Bluetooth-Adapter/Quellenwechsel noch nicht implementiert. |
| Schwellenberechnung | offen | Diagnostik-Kern ist deterministisch/versioniert, aber die fachliche Berechnung/Festschreibung hat noch kein eigenes Audit-Ereignis. |
| manuelle LT1-/LT2-/Zonenfestlegung | offen | Fachkern/Entscheidungslogik vorhanden; persistenter auditierter Writer muss noch vervollständigt werden. |
| Freigabe und Berichtsversion | offen | Immutable Ergebnis-/Berichtsversionen existieren, aber SPEC-konforme Freigabe-/Version-Audit-Events sind noch nicht vollständig nachgewiesen. |
| Exporte | teilweise | Tenant-Export-Erstellung und einmaliger Download auditiert; Test-/Analyse-/Berichtsexporte müssen noch als Ereigniskategorie vereinheitlicht werden. |
| Löschung und Anonymisierung | teilweise | Löschantrag, Entscheidung und Abschluss werden auditiert; irreversible Pseudonymisierung/Anonymisierung ist noch offen. |
| Vorlagen- und Zonenregeländerungen | teilweise | Protokollvorlage und neue Vorlagenversion werden auditiert; Zonenregeländerungen sind noch nicht vollständig als eigener Writer abgedeckt. |
| Backup, Restore, Update und Setup | teilweise | `club.bootstrap.completed` ist zentral auditiert; Backup/Restore/Update folgen mit Epic 12. |
| Lock-Aufhebung | abgedeckt | `test.lock.released` mit Actor-/Session-Kontext. |

## Audit-Datensatz nach SPEC §33.2

Der zentrale Datensatz unterstützt:

- Zeitpunkt (`occurred_at`, zusätzlich Aufzeichnungszeit über `created_at`),
- Identität und Rolle,
- Tenant,
- Aktion, Entität und Entitäts-ID,
- Vorher-/Nachher-Zustand,
- Begründung,
- Auth-Provider,
- Sitzungskennung,
- technische Herkunft (`source`),
- Korrelations-ID.

Nicht jede Ereignisklasse muss alle optionalen Felder belegen. Bei nicht authentifizierten technischen Vorgängen ist `NULL` semantisch korrekter als eine abgeleitete oder erfundene Identität.

## Abschlusskriterium für „Audit-Abdeckung aller spezifizierten Ereignisse“

Der Task darf erst geschlossen werden, wenn mindestens folgende Restpunkte entweder implementiert oder explizit aus dem MVP-Scope entfernt wurden:

1. Auth-Lifecycle: Login, Fehlversuch, Logout.
2. Rollenänderungen.
3. Unterbrechung/Resume als serverseitiger, auditierbarer Testzustand oder dokumentierte SPEC-Anpassung.
4. Schwellenberechnung und manuelle LT1-/LT2-/Zonenentscheidung.
5. Freigabe und Berichtsversion.
6. Test-, Analyse- und Berichtsexporte.
7. irreversible Löschung/Pseudonymisierung.
8. Zonenregeländerungen.
9. Bluetooth-Quellenwechsel mit Epic 11.
10. Backup/Restore/Update mit Epic 12.

Diese Matrix ist absichtlich konservativ: vorhandene Fachfunktionalität ohne nachgewiesenes Audit-Ereignis zählt nicht als abgedeckt.