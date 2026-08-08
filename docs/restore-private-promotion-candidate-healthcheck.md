# Private Restore Promotion Candidate Healthcheck

## Zweck

Nach der Befüllung der vier plan-gebundenen Kandidaten-Volumes muss der Kandidaten-Satz erneut als Ganzes geprüft werden, bevor überhaupt ein produktiver Switch entworfen werden darf.

Der Candidate Healthcheck ist vollständig read-only:

```text
candidateMutationAllowed = false
productionMutationAllowed = false
promotionExecuted = false
```

Ein grüner Candidate Healthcheck ist damit noch keine Switch-Autorisierung.

## Erneute Trust-Chain-Prüfung

Der Host-Befehl startet nicht mit den Kandidaten-Volumes, sondern erneut mit der vollständigen technischen Restore-Evidence:

```text
Raw Restore Evidence
-> Promotion Readiness
-> Promotion Intent
-> Promotion Execution Preflight
-> Promotion Execution Plan
-> aktuell aktiver Rollback-Volume-Satz
```

Die gemeinsame Service-Funktion `verifyRestorePrivatePromotionCandidatePlan...` wird sowohl von der Candidate-Mutationsautorisierung als auch vom Candidate Healthcheck verwendet. Dadurch kann die spätere read-only Prüfung nicht versehentlich eine schwächere Interpretation von Intent, Preflight oder Plan verwenden.

Der Preflight-CLI lautet:

```bash
pnpm --filter @masters/db backup:restore-promotion-candidates-preflight
```

Er liefert nur bei weiterhin konsistenter Evidence:

```text
status = CANDIDATE_SET_CHECK_READY
evidenceRecomputed = true
candidateMutationAllowed = false
productionMutationAllowed = false
promotionExecuted = false
```

Gebunden werden weiterhin:

- Backup-Cutoff,
- Execution-Fingerprint,
- Plan-Fingerprint und Plan-Signatur,
- Candidate-Set-ID,
- Fingerprint des aktuell aktiven Rollback-Volume-Satzes,
- alle vier Rollen mit aktivem, Kandidaten- und Rollback-Volume.

## Aktive Rollback-Volumes werden erneut aufgelöst

Der Host-Wrapper verwendet erneut:

- den aktuell gerenderten Club-Compose-Stack,
- die tatsächlich laufenden `app`-/`libsql`-Container,
- `docker inspect` ihrer Mounts.

Damit muss der aktuell aktive Satz noch exakt dem im signierten Execution Plan gebundenen Rollback-Satz entsprechen. Drift eines aktiven Volume-Namens macht bereits den Candidate-Set-Preflight ungültig.

Die aktiven Volumes werden nicht als Healthcheck-Mounts verwendet und nicht beschrieben.

## Quiescenter privater libSQL-Quellbaum

Für die erneute Plan-/Readiness-Prüfung wird die private Restore-DB kurz gestartet und idempotent migriert.

Danach wird sie **vor** dem Dateisystem-Healthcheck gestoppt. Dadurch ist insbesondere `/restore-replay/libsql` während des Fingerprint-Vergleichs quiescent.

Die Reihenfolge ist zwingend:

```text
fresh candidate-set preflight
-> private Restore-DB stoppen
-> Kandidaten-Labels prüfen
-> Kandidaten read-only fingerprinten
```

## Kandidaten-Identität

Jedes der vier Kandidaten-Volumes muss existieren. Ein fehlendes Volume blockiert; der Healthcheck erzeugt es niemals.

Vor dem Mount werden erneut geprüft:

- exakter Kandidaten-Name aus dem signierten Plan,
- Docker Driver `local`,
- Scope `local`,
- `promotion-candidate=true`,
- Plan-Fingerprint-Label,
- Candidate-Set-Label,
- Rollen-Label,
- Rollback-Volume-Label,
- kein Container verwendet das Kandidaten-Volume aktuell.

Der Healthcheck enthält weder `docker volume create` noch `docker volume rm`.

## Gemeinsamer Tree-Fingerprint

Copy und Healthcheck verwenden exakt denselben Service:

```text
restore-private-promotion-candidate-tree.ts
```

Der Algorithmus bindet deterministisch:

- relativen Pfad,
- Datei-/Verzeichnistyp,
- Mode,
- UID/GID,
- Dateigröße,
- SHA-256 jedes Dateiinhalts,
- Mode/UID/GID des Root-Verzeichnisses.

Symlinks und andere Spezialdateien sind nicht zulässig.

Dadurch kann der Copy-Workflow keinen anderen Begriff von „identisch“ verwenden als der spätere Healthcheck.

## Read-only Candidate Check Service

Container-CLI:

```bash
pnpm --filter @masters/db backup:restore-promotion-candidate-check
```

Compose-Service:

```text
backup-restore-promotion-candidate-check
```

Er sieht ausschließlich:

```text
/restore-replay  read-only
/candidate       read-only
```

Zusätzlich:

- `network_mode: none`,
- kein Docker-Socket,
- keine Datenbank,
- keine Schlüssel,
- keine produktiven Volumes,
- keine Service-Abhängigkeiten.

Einzelresultat:

```text
status = HEALTHY
candidateMutationAllowed = false
productionMutationAllowed = false
promotionExecuted = false
sourceFingerprint = candidateFingerprint
```

Ändert sich der private Quellbaum nach der Kandidatenkopie oder verändert sich der Kandidat, blockiert der Check ohne den Kandidaten zu reparieren.

## Host-Befehl und Vierer-Aggregation

Operativer Einstiegspunkt:

```bash
bash infra/backup/check-club-restore-promotion-candidates.sh restore-<timestamp>-<uuid>
```

Der Wrapper führt für alle vier Rollen in kanonischer Reihenfolge einen read-only Einzelcheck aus und aggregiert die Resultate.

Nur wenn alle vier Kandidaten gesund sind, entsteht:

```text
mode = ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_HEALTHCHECK
status = CANDIDATE_SET_HEALTHY
healthcheckVersion = 1
evidenceRecomputed = true
candidateMutationAllowed = false
productionMutationAllowed = false
promotionExecuted = false
```

Der Report enthält:

- Plan-Fingerprint,
- Active-Volume-Set-Fingerprint,
- Candidate-Set-ID,
- pro Rolle Kandidaten-/Rollback-Name und Tree-Fingerprints/Counts,
- einen deterministischen `candidateSetFingerprint` über den gesamten Vierer-Satz.

Der Report wird nur auf stdout ausgegeben. Er ist noch kein durable Switch Intent.

## Stale-Candidate-Schutz

Der Docker-Contract prüft explizit:

```text
Candidate copy gesund
-> private Quelle ändert sich
-> read-only Candidate Check blockiert
-> Candidate copy wird erneut ausgeführt
-> read-only Candidate Check wird wieder grün
```

Der Healthcheck korrigiert niemals selbst einen stale Kandidaten. Mutation und Verifikation bleiben getrennte Schritte.

## Server-Contracts

`Restore Promotion Candidate Contract` beweist mit einem echten temporären Docker-Volume:

- Copy und Healthcheck verwenden kompatible Tree-Fingerprints,
- gesunder Kandidat wird read-only akzeptiert,
- Source-Drift wird read-only erkannt,
- erneute Copy stellt Gesundheit wieder her,
- Symlink-Sperre bleibt nach dem Refactor erhalten,
- der Check-Service mountet das Kandidaten-Volume read-only.

`Restore Promotion Plan Contract` beweist zusätzlich, dass der Candidate-Set-Preflight die aktuelle signierte Intent-/Preflight-/Plan-Kette erneut prüft und keinerlei Mutation autorisiert.

`Restore Promotion Wiring Contract` erzwingt hostseitig:

```text
fresh candidate-set preflight
-> private DB stoppen
-> volume inspect / label check
-> read-only candidate check
```

und verbietet im Healthcheck-Wrapper:

- `docker volume create`,
- `docker volume rm`,
- Candidate Copy,
- `docker cp`,
- produktives `docker compose down`,
- Replay-/Recovery-Neuausführung.

## Sicherheitsgrenze

Ein `CANDIDATE_SET_HEALTHY`-Report bedeutet ausschließlich:

> Der aktuell signierte Promotion-Plan, der aktuell aktive Rollback-Satz und die vier nicht aktiven Kandidaten sind in diesem Prüfzeitpunkt technisch konsistent.

Er erlaubt noch keine Downtime oder produktive Umschaltung.

Als nächster Slice folgt zunächst ein **Switch-Vertrag / Switch Intent**, der einen unmittelbar erneut berechneten Candidate-Healthcheck an einen konkreten Selector-Wechsel bindet und Crash-/Rollback-Semantik festlegt. Erst ein danach separat kontrollierter Executor darf produktive Dienste stoppen oder den aktiven Volume-Satz wechseln.

Bis Switch-Executor, Promotion-Audit und praktischer RTO-Drill abgeschlossen sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
