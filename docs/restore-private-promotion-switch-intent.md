# Private Restore Promotion Switch Intent

## Zweck

Nach einem grünen Candidate-Set-Healthcheck darf noch nicht direkt in Produktion umgeschaltet werden. Zwischen der technischen Kandidatenprüfung und einer späteren Downtime braucht es einen durable, signierten Vertrag, der exakt festlegt, **welcher Kandidaten-Satz welchen Rollback-Satz ersetzen darf** und welche Crash-/Rollback-Regeln ein späterer Executor zwingend einhalten muss.

Der Switch Intent ist diese Autorisierungsschicht.

Er autorisiert erstmals einen späteren produktiven Switch:

```text
productionSwitchAuthorized = true
```

führt ihn aber selbst ausdrücklich nicht aus:

```text
productionMutationApplied = false
promotionExecuted = false
```

## Frischer Candidate-Healthcheck als einzige Quelle

Der Host-Befehl lautet:

```bash
bash infra/backup/authorize-club-restore-promotion-switch.sh restore-<timestamp>-<uuid>
```

Er akzeptiert keine vom Operator angegebene Healthcheck-Datei und keinen alten gespeicherten `CANDIDATE_SET_HEALTHY`-Report.

Stattdessen führt er unmittelbar vor der Signierung erneut aus:

```bash
bash infra/backup/check-club-restore-promotion-candidates.sh restore-<timestamp>-<uuid>
```

Damit wird erneut geprüft:

- aktuelle Raw Restore Evidence,
- Promotion Intent,
- Execution Preflight,
- signierter Execution Plan,
- aktuell aktiver Rollback-Volume-Satz,
- Kandidaten-Labels,
- Unbenutztheit der vier Kandidaten,
- vier Source-/Candidate-Tree-Fingerprints.

Nur das finale JSON dieses frischen Laufs wird als temporäre Datei normalisiert und an den Switch-Intent-CLI weitergegeben.

## Candidate-Set-Fingerprint

Der Switch Intent akzeptiert ausschließlich:

```text
mode = ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_HEALTHCHECK
status = CANDIDATE_SET_HEALTHY
healthcheckVersion = 1
evidenceRecomputed = true
candidateMutationAllowed = false
productionMutationAllowed = false
promotionExecuted = false
```

Der Report wird vollständig strukturell validiert. Für alle vier Rollen müssen gelten:

- kanonische Reihenfolge und Rolle,
- sicherer Kandidaten-Volume-Name,
- sicherer Rollback-Volume-Name,
- Kandidat und Rollback verschieden,
- vier Kandidaten eindeutig,
- vier Rollback-Volumes eindeutig,
- beide Mengen disjunkt,
- `sourceFingerprint == candidateFingerprint`,
- valide Counts und Bytezahl.

Zusätzlich wird `candidateSetFingerprint` nochmals aus dem kanonischen Report-Inhalt berechnet. Ein syntaktisch grüner Report mit verändertem Inhalt ist daher nicht autorisierbar.

## Switch Intent v1

Datei:

```text
promotion/switch/promotion-switch-intent.json
```

Der Record besitzt:

```text
switchIntentVersion = 1
phase = PENDING
productionSwitchAuthorized = true
promotionExecuted = false
```

Er bindet:

- `authorizedAt`,
- Candidate-Healthcheck-Version,
- Candidate-Set-Fingerprint,
- Execution-Plan-Fingerprint,
- Fingerprint des bisher aktiven Rollback-Satzes,
- Candidate-Set-ID,
- alle vier Kandidaten-/Rollback-Volume-Namen,
- Tree-Fingerprint jedes Kandidaten.

Damit ist die spätere Umschaltung nicht nur an logische Rollen, sondern an konkrete, bereits geprüfte Docker-Volumes gebunden.

## Selector-Vertrag

Der geplante Selector-Vertrag lautet:

```text
selectorStrategy = COMPOSE_EXTERNAL_NAMED_VOLUMES_V1
```

Ein späterer Executor darf den aktiven Satz daher nur über explizit gebundene externe Named Volumes umschalten. Ein In-place-Überschreiben der bisherigen Produktions-Volumes bleibt ausgeschlossen.

## Rollback- und Caddy-Policy

```text
rollbackStrategy = KEEP_PREVIOUS_ACTIVE_VOLUMES
rollbackVolumesMustRemain = true
caddyPolicy = PRESERVE_CURRENT
```

Die bisher aktiven vier App-Daten-Volumes bleiben während des Cutovers als unveränderter Rollback-Satz erhalten. Sie dürfen vor erfolgreichem Abschluss weder gelöscht noch überschrieben werden.

Caddy-/TLS-State wird weiterhin nicht aus dem Backup zurückgesetzt.

## Crash-Recovery-Vertrag

Der Switch Intent verlangt ausdrücklich:

```text
crashRecoveryPolicy = DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION
```

Das bedeutet: Ein späterer mutierender Executor darf **keinen** produktiven Dienst stoppen, keinen Selector ändern und keinen aktiven Container neu erzeugen, bevor ein durable Switch-Journal den geplanten Cutover und den gebundenen Rollback-Satz festgehalten hat.

Damit muss ein Prozessabsturz nach Beginn der Downtime aus dauerhafter technischer Evidence rekonstruierbar sein.

## Fehlgeschlagener Cutover

```text
rollbackPolicy = RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER
```

Scheitert der Kandidaten-Cutover oder der Post-Switch-Healthcheck, muss der spätere Executor den **im Intent gebundenen bisherigen Rollback-Satz** wieder selektieren. Er darf keinen neu ermittelten oder heuristisch gewählten Volume-Satz verwenden.

## Abschlussbedingung

```text
completionPolicy = SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK
```

Ein Switch darf erst dann als abgeschlossen gelten, wenn:

1. der Kandidaten-Satz produktiv selektiert wurde,
2. ein definierter Post-Switch-Healthcheck erfolgreich war,
3. ein signierter Completion Receipt diesen Zustand durable bindet.

Bis dahin bleibt der Switch logisch PENDING.

## Zwingende erneute Prüfung vor echter Mutation

Der Switch Intent ist durable, aber nicht zeitlich unbegrenzt ausreichend.

Er trägt daher:

```text
preSwitchHealthcheckRequired = true
```

Ein späterer Executor muss unmittelbar vor der **ersten** Produktivmutation den Candidate-Set-Healthcheck erneut berechnen und verlangen, dass dessen Candidate-Set-Fingerprint exakt dem Switch Intent entspricht.

Ändert sich nach der Autorisierung ein Kandidat, ein Rollback-Volume, die Restore-Evidence oder ein Tree-Fingerprint, darf der Intent nicht verwendet werden.

## Signatur und Persistenz

Switch Intent v1 verwendet HMAC-SHA256 mit eigener Domain Separation:

```text
masters:restore-private-promotion-switch-intent:v1
```

Der bereits unabhängige Promotion-Key wird verwendet, jedoch kryptografisch von Promotion Intent und Execution Plan getrennt.

Persistenzregeln:

- eigener Unterordner `promotion/switch`,
- Verzeichnis `0700`,
- Intent-Datei `0600`,
- exklusives Anlegen,
- identischer Retry reused den ursprünglichen `authorizedAt`,
- veränderter Candidate-Set-Healthcheck kann einen vorhandenen Intent nicht übernehmen,
- HMAC- und Safety-Policy-Tampering blockiert.

## Isolierter Switch-Intent-Service

Compose-Service:

```text
backup-restore-promotion-switch-intent
```

Er besitzt nur:

- Promotion-Key read-only,
- `promotion/switch` read-write,
- die vom Host dynamisch eingehängte Candidate-Healthcheck-Datei read-only.

Zusätzlich:

- `network_mode: none`,
- kein Docker-Socket,
- keine Kandidaten-Volumes,
- keine Rollback-/Produktiv-Volumes,
- keine private Restore-DB,
- keine Ledger-/Journal-/Recovery-Dateien,
- keine Service-Abhängigkeiten.

Der Service kann deshalb die Autorisierung signieren, aber keinen Switch durchführen.

## Server-Contracts

`Restore Promotion Switch Intent Contract` prüft:

- Python-kompatiblen Candidate-Set-Fingerprint,
- HMAC-signierte Persistenz,
- `0700/0600`,
- identischen Retry mit stabilem `authorizedAt`,
- alle Crash-/Rollback-/Completion-Policies,
- geänderter Candidate-Set-Report kann den vorhandenen Intent nicht reusen und verändert ihn nicht.

`Restore Promotion Switch Wiring Contract` prüft:

- frischer Candidate-Healthcheck läuft vor der Signierung,
- temporäre Healthcheck-Datei wird nur read-only gemountet,
- separater `promotion/switch`-Unterordner,
- Switch-Service ohne Netzwerk, Docker-Socket oder Daten-Volumes,
- Host-Wrapper enthält keine Volume-Erzeugung/-Löschung/-Copy, kein `compose down` und keinen Dienst-Stopp.

## Aktuelle Sicherheitsgrenze

Nach diesem Slice existiert erstmals eine durable Autorisierung für einen späteren Produktiv-Switch, aber weiterhin:

- keine Downtime,
- kein Selector-Wechsel,
- kein produktiver Container wird gestoppt oder neu erzeugt,
- keine Kandidaten-/Rollback-Volumes werden verändert,
- kein Switch-Journal existiert,
- kein Switch Completion Receipt existiert,
- `promotionExecuted` bleibt `false`.

Der nächste Slice muss deshalb **zuerst das durable Switch-Journal und den konkreten Selector-/Rollback-Vertrag implementieren**, bevor irgendein mutierender Switch-Executor entstehen darf.

Bis Switch-Executor, Promotion-Audit und praktischer RTO-Drill abgeschlossen sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
