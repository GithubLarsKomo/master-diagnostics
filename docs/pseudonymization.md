# Pseudonymisierung nach Athletenlöschung

## Ziel und SPEC-Grenze

Die irreversible Verarbeitung wird bewusst in mehrere getrennte Schritte zerlegt. Ein Soft-Delete ist keine DSGVO-Löschung. Nach SPEC §32 darf eine Löschung oder irreversible Anonymisierung erst nach Prüfung der Aufbewahrungsgründe erfolgen. SPEC §33.3 verlangt gleichzeitig, Audit-Logs wie die Fachdaten mindestens drei Jahre aufzubewahren und direkte Identifikatoren darin nach Athletenlöschung zu pseudonymisieren.

Daraus folgt: Ein späterer irreversibler Writer darf Fachdaten nicht isoliert pseudonymisieren und anschließend einen weiterhin identifizierenden Audit-Trail zurücklassen.

## Read-only Schutzprüfung

`getAthletePseudonymizationReadiness()` ist ausschließlich lesend. Der Service prüft:

- Aufbewahrungsfrist ist abgelaufen; `MANUAL_REVIEW` bleibt fail-closed.
- Ein Löschworkflow wurde bis `COMPLETED` geführt.
- Das Athletenprofil ist bereits soft-gelöscht.
- Die Nutzung ist gesperrt.
- Audit-Ereignisse des Athleten werden auf direkte Identifikatoren inventarisiert.

Blocker werden deterministisch ausgewiesen. `eligibleForExplicitApproval = true` ist **keine** Freigabe und führt keine Änderung aus. Es bedeutet nur, dass die fachlichen Schutzbedingungen für eine nachgelagerte explizite Freigabe erfüllt sind.

## Audit-Identifikatoren

Der bestehende Audit-Trail enthält historisch teilweise vollständige Vorher-/Nachher-Payloads, zum Beispiel Namen und Geburtsdatum bei Athletenänderungen oder Kontaktdaten bei Guardian-Ereignissen. Zusätzlich können Freitext-Begründungen Identifikatoren enthalten.

Die Readiness inventarisiert deshalb betroffene Audit-Event-IDs, ohne deren Inhalte zu verändern. Als direkte bzw. unmittelbar verknüpfende Identifikatoren werden konservativ behandelt:

- Vor- und Nachname
- Geburtsdatum
- Guardian-/Personenname
- E-Mail und Telefonnummer
- Display-Name
- direkte Benutzerverknüpfung
- freie Begründungstexte in athletenbezogenen Audit-Ereignissen

Malformed JSON wird fail-closed als pseudonymisierungspflichtig behandelt.

## Noch nicht implementierter irreversible Writer

Der spätere Writer muss in einer neu zu definierenden, kontrollierten Transaktion mindestens:

1. eine explizite irreversible Freigabe nachweisen,
2. die Readiness unmittelbar vor dem Schreiben erneut prüfen,
3. direkte Identifikatoren in den Fachdaten pseudonymisieren/entfernen,
4. die durch die Readiness ermittelten direkten Audit-Identifikatoren gemäß SPEC §33.3 pseudonymisieren,
5. den Audit-Nachweis der Pseudonymisierung selbst ohne direkte Athletenidentifikatoren append-only protokollieren,
6. bei jedem Teilfehler vollständig zurückrollen.

Der aktuelle generelle `audit_events_immutable_update`-Trigger verhindert Punkt 4. Er darf nicht pauschal gelockert werden. Vor Implementierung des Writers ist daher ein eng begrenzter, DB-seitig überprüfbarer Privacy-Maintenance-Pfad zu entwerfen, der ausschließlich eine monotone Pseudonymisierung erlaubt und normale Audit-Manipulation weiterhin verhindert.

## Sicherheitsentscheidung

Bis dieser kontrollierte Audit-Pseudonymisierungspfad und die explizite irreversible Freigabe existieren, wird kein produktiver Pseudonymisierungswriter bereitgestellt. Damit bleibt der bestehende Datenschutzpfad fail-closed.
