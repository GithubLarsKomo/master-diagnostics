# Private Restore Promotion Candidates

## Zweck

Nach einem signierten Promotion Execution Plan dürfen erstmals Docker-Volumes mutiert werden. Diese Mutation bleibt strikt außerhalb des aktiven Produktionssatzes.

Candidate Preparation erzeugt und befüllt ausschließlich die vier im signierten Plan gebundenen **neuen Kandidaten-Volumes**. Die aktuell aktiven Volumes bleiben unverändert und bilden weiterhin den Rollback-Satz.

Die neue Autorisierungsgrenze lautet:

```text
candidateMutationAllowed = true
productionMutationAllowed = false
promotionExecuted = false
```

Ein erfolgreicher Kandidaten-Copy ist daher noch keine Promotion.

## Vertrauenskette vor der ersten Volume-Mutation

Unmittelbar vor `docker volume create` wird die gesamte Promotion-Evidence erneut verifiziert:

1. aktuelle Raw Restore Evidence,
2. Promotion Readiness,
3. signierter Promotion Intent,
4. frischer Promotion Execution Preflight,
5. signierter Promotion Execution Plan,
6. erneut hostseitig aufgelöster aktiver Volume-Satz.

Der read-only CLI

```bash
pnpm --filter @masters/db backup:restore-promotion-candidates-authorize
```

liefert nur bei vollständiger Übereinstimmung:

```text
status = CANDIDATE_COPY_AUTHORIZED
evidenceRecomputed = true
candidateMutationAllowed = true
productionMutationAllowed = false
promotionExecuted = false
```

Er bindet außerdem Plan-Fingerprint, Plan-Signatur, Kandidaten-Satz und alle vier Volume-Rollen.

## Host-Befehl

Der operative Einstiegspunkt lautet:

```bash
bash infra/backup/prepare-club-restore-promotion-candidates.sh restore-<timestamp>-<uuid>
```

Der Wrapper:

1. validiert Staging, privaten Workspace, Promotion Intent und Execution Plan,
2. löst die aktuell aktiven Volumes erneut aus gerendertem Compose + laufenden Containern auf,
3. startet die private Restore-DB nur für die frische Autorisierungsprüfung,
4. migriert die private DB idempotent,
5. führt den Candidate-Authorization-CLI aus,
6. stoppt die private Restore-DB **vor** jeder Kopie,
7. validiert die autorisierten Kandidaten-/Rollback-Identitäten,
8. erzeugt oder verifiziert die vier Kandidaten-Volumes,
9. kopiert jede Rolle einzeln über den isolierten Copy-Service.

Der produktive `app`-/`libsql`-Stack bleibt während dieses Slices unverändert aktiv.

## Warum die private DB vor der Kopie gestoppt wird

Der private Workspace-Unterpfad `libsql` ist die Quelle des künftigen Kandidaten-Volumes. Ein live laufender libSQL-Prozess könnte während der Dateikopie Dateien verändern und dadurch einen inkonsistenten Kandidaten erzeugen.

Deshalb gilt die Reihenfolge zwingend:

```text
fresh authorization
-> private replay DB stoppen
-> Kandidaten erzeugen/kopieren
```

Der Copy-Service startet die private DB nicht erneut.

## Kandidaten-Volume-Identität

Ein neuer Kandidat wird nur unter dem im signierten Plan enthaltenen deterministischen Namen angelegt. Er erhält technische Labels:

```text
com.master-diagnostics.restore.promotion-candidate=true
com.master-diagnostics.restore.plan-fingerprint=<sha256:...>
com.master-diagnostics.restore.candidate-set=<restore-20hex>
com.master-diagnostics.restore.role=<ROLE>
com.master-diagnostics.restore.rollback-volume=<previous-active-volume>
```

Existiert ein Kandidaten-Volume bereits, wird es **nicht** anhand des Namens allein übernommen. Vor jeder Kopie müssen zusätzlich gelten:

- exakt derselbe Name,
- Docker Driver `local`,
- Scope `local`,
- alle fünf Identitätslabels stimmen exakt,
- kein Container verwendet das Volume aktuell.

Auch ein gerade neu erzeugtes Volume wird anschließend nochmals auf diese Eigenschaften geprüft. Das verhindert, dass ein Namensrennen oder ein fremdes Alt-Volume als Kandidat übernommen wird.

## Rollback-Volumes bleiben unberührt

Die aktiven Volumes werden nur als technische Namen in der Autorisierung und als `rollback-volume`-Label verwendet.

Der Candidate-Wrapper:

- mountet kein aktives Volume,
- beschreibt kein aktives Volume,
- löscht kein aktives Volume,
- verwendet kein aktives Volume als Copy-Ziel.

Er enthält insbesondere kein `docker volume rm`, kein `docker cp` und kein produktives `docker compose down`.

## Isolierter Copy-Service

Compose-Service:

```text
backup-restore-promotion-candidate-copy
```

Der Service sieht genau zwei Datenpfade:

```text
/restore-replay  read-only
/candidate       read-write
```

Zusätzlich gilt:

- `network_mode: none`,
- kein Docker-Socket,
- keine Datenbankverbindung,
- keine Ledger-/Journal-/Promotion-Keys,
- keine produktiven Named Volumes,
- keine Abhängigkeit zu einem laufenden Service.

Das Kandidaten-Volume ist als `external: true` definiert. Compose darf es daher nicht implizit erzeugen; nur der Host-Wrapper darf nach erfolgreicher Autorisierung `docker volume create` aufrufen.

## Copy- und Verifikationsvertrag

Der Copy-CLI lautet:

```bash
pnpm --filter @masters/db backup:restore-promotion-candidate-copy
```

Pro Rolle ist der Quellpfad fest im Code gebunden:

- `LIBSQL` → `/restore-replay/libsql`
- `REPORTS` → `/restore-replay/reports`
- `TENANT_EXPORTS` → `/restore-replay/tenant-exports`
- `DATA_SUBJECT_DELIVERY` → `/restore-replay/data-subject-delivery`

Vor der Kopie wird der vollständige Quellbaum traversiert. Zulässig sind ausschließlich reguläre Dateien und Verzeichnisse. Symlinks und sonstige Spezialdateien blockieren fail-closed.

Für jede Datei werden gebunden:

- relativer Pfad,
- Typ,
- Mode,
- UID/GID,
- Größe,
- SHA-256 des Inhalts.

Für Verzeichnisse werden Pfad, Mode und UID/GID gebunden. Zusätzlich fließen Mode/UID/GID des Wurzelverzeichnisses ein.

Aus dieser kanonischen Struktur entsteht ein deterministischer Tree-Fingerprint.

Danach:

1. wird das Kandidaten-Volume vollständig geleert,
2. der Quellbaum mit Archiv-Semantik kopiert,
3. Root-Ownership/-Mode angeglichen,
4. der Kandidatenbaum mit demselben Algorithmus erneut fingerprinted.

Nur wenn Fingerprint, Datei-/Verzeichniszahl und Bytezahl exakt übereinstimmen, entsteht:

```text
status = COPIED_AND_VERIFIED
candidateMutationApplied = true
productionMutationAllowed = false
promotionExecuted = false
sourceFingerprint = candidateFingerprint
```

## Retry- und Fehlersemantik

Ein Kandidaten-Volume kann nach einem Fehler bestehen bleiben. Es ist noch nicht aktiv und trägt seine Planidentität als Labels.

Ein Retry:

- akzeptiert es nur bei exakt passenden Labels,
- verlangt, dass kein Container es verwendet,
- leert den gesamten Inhalt,
- kopiert den aktuellen privaten Quellbaum erneut,
- verifiziert den Tree-Fingerprint erneut.

Ein Volume mit falschen Labels wird niemals automatisch gelöscht oder adoptiert. Der Workflow stoppt stattdessen fail-closed.

## Caddy

Caddy bleibt außerhalb des Kandidaten-Satzes:

```text
caddyPolicy = PRESERVE_CURRENT
```

Es werden weiterhin nur die vier fachlichen App-Datenbereiche vorbereitet.

## Server-Contracts

`Restore Promotion Plan Contract` prüft zusätzlich, dass Candidate Preparation nur aus der vollständigen aktuellen Intent-/Preflight-/Plan-Kette autorisiert wird.

`Restore Promotion Candidate Contract` verwendet ein echtes temporäres Docker-Volume und beweist:

- isolierte Reports-Kopie,
- identische Source-/Candidate-Fingerprints,
- Erhaltung technischer Baum-Metadaten im Fingerprint,
- Retry entfernt vorherigen Altinhalt vollständig,
- ein Symlink im privaten Quellbaum wird vor der Kandidatenmutation abgelehnt,
- der Copy-Service besitzt weder Netzwerk noch Docker-Socket oder Produktiv-Mounts.

`Restore Promotion Wiring Contract` erzwingt zusätzlich die Host-Reihenfolge:

```text
candidate authorize
-> private DB stoppen
-> Kandidaten-Volume anlegen/verifizieren
-> isoliert kopieren
```

## Noch nicht implementiert

Dieser Slice:

- schaltet keinen Kandidaten produktiv,
- stoppt keine produktiven Dienste,
- verändert keinen Compose-Selector,
- führt keinen Kandidaten als Produktions-DB aus,
- löscht keinen Rollback-Satz,
- setzt `promotionExecuted` nicht auf `true`.

Als nächstes folgt ein **read-only Candidate Healthcheck**, der Plan-/Label-Bindung, aktuelle aktive Rollback-Volumes und die vier befüllten Kandidaten erneut verifiziert. Erst danach darf ein weiterer Slice eine kontrollierte Produktivumschaltung entwerfen.

Bis Promotion-Switch, Audit und praktischer RTO-Drill abgeschlossen sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
