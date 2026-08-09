# Backup Privacy Live Runtime Handoff v1

## Zweck

Die Runtime-Boundary aus #229 macht bewusst sichtbar, dass ein frisch gestarteter Policy-Check mit Target-`.env` noch kein Beweis für bereits laufende Club-Prozesse ist.

Dieser Slice schließt genau die daraus entstehende Übergabelücke, ohne `activationExecuted=true` vorwegzunehmen.

Der Produktionspfad lautet nun:

```text
signed Activation Plan v2
  -> signed #225 PENDING execution
  -> atomarer Target-.env-Write
  -> kanonischer Checker verlangt LIVE_RUNTIME_ATTESTATION_REQUIRED
  -> signed non-terminal Live Handoff
  -> späterer Service-Cutover-Plan / Live-Baseline / Recreate
```

## Gemeinsame Transaktionsgrenze mit #226

`stage-backup-privacy-live-handoff.py` importiert keine eigenen freien Env-Mutationsregeln. Er verwendet die bereits serverseitig getesteten #226-Primitiven für:

- Plan-v2-Verifikation,
- PENDING-Verifikation,
- Target-Rekonstruktion,
- atomaren Same-Directory-Replace mit `fsync`,
- bytegenaue Rollback-Rekonstruktion,
- Runtime-Policy-Aufruf,
- signierte #226-Rollback-Marker.

Zusätzlich verwendet er **denselben**:

```text
activation-executor.lock
```

Damit können #226-Executor und Handoff-Stager nicht gleichzeitig dieselbe Aktivierung mutieren.

## Erlaubter nichtterminaler Boundary-Zustand

Nachdem die `.env` exakt den signierten `targetEnvFingerprint` erreicht hat, wird der kanonische Runtime-Checker auf ENABLED ausgeführt.

Nur exakt dieser Fail-closed-Befund gilt als erwartete Übergabe und **nicht** als Aktivierungsfehler:

```text
readyForIrreversibleProcessing=false
backupState=ENABLED
attestationScope=STATIC_ENV_POLICY_ONLY
blockers=[LIVE_RUNTIME_ATTESTATION_REQUIRED]
```

Nur dann darf die Target-`.env` stehen bleiben.

Jeder andere ENABLED-Validierungsfehler behält die bisherige Sicherheitssemantik:

1. #226 `ROLLBACK_STARTED` wird signiert persistiert,
2. Plan-v2-`rollbackDescriptor` rekonstruiert bytegenau den Ausgangszustand,
3. `.env` wird atomar zurückgesetzt,
4. DISABLED-Policy wird erneut verifiziert,
5. #226 `ROLLBACK_VERIFIED` wird signiert persistiert.

## Signierte Handoff-Evidence

Datei:

```text
<execution-dir>/activation-execution-live-runtime-handoff.json
```

HMAC-Domain:

```text
masters:backup-privacy-live-handoff:v1
```

Das Handoff bindet exakt die vorhandene #225/#226-Identität:

- `activationId`,
- `executionId`,
- `executionFingerprint`,
- SHA-256 der PENDING-Evidence,
- Plan-Fingerprint,
- absoluten `.env`-Pfad,
- Pre-/Target-Fingerprint,
- SHA-256 des statischen Boundary-Outputs.

Safety-Felder sind fest:

```text
phase=TARGET_APPLIED
handoffReasonCode=LIVE_RUNTIME_ATTESTATION_REQUIRED
requiredNextProof=LIVE_CLUB_PROCESS_ATTESTATION
runtimeConfigurationChanged=true
activationExecuted=false
terminal=false
```

Die Datei ist `0600` im bereits privaten activation-spezifischen Execution-Verzeichnis.

## Crash-/Retry-Verhalten

### Crash vor Target-Write

Die #225-Evidence bleibt `READY_TO_APPLY`. Ein Retry darf den signierten Target-Write ausführen.

### Crash nach Target-Write, vor Handoff-Evidence

Die #225-Evidence erkennt `READY_TO_VALIDATE`. Der Stager schreibt die `.env` nicht erneut, reproduziert den kanonischen Boundary-Befund und persistiert nur die fehlende Handoff-Evidence.

### Retry nach Handoff

Wenn HMAC-Evidence gültig ist und die `.env` weiterhin exakt dem Target-Fingerprint entspricht:

```text
ALREADY_AWAITING_LIVE_RUNTIME_CUTOVER
```

Es findet kein weiterer Env-Write statt.

### Drift nach Handoff

Jeder Env-Fingerprint ungleich dem signierten Target-Fingerprint blockiert. Ein Handoff wird nicht als Erlaubnis interpretiert, Drift automatisch zu reparieren.

## Read-only Verifier

```bash
python3 infra/backup/check-backup-privacy-live-handoff.py \
  --plan /absolute/activation-plan.json \
  --pending /absolute/activation-execution-pending.json \
  --key-file /absolute/key \
  --env-file /absolute/club.env
```

Der Verifier prüft:

- Plan v2,
- #225 PENDING,
- Handoff-Fingerprint und HMAC,
- exakte Env-Target-Bindung,
- Abwesenheit von #226 `ROLLBACK_STARTED` / `ROLLBACK_VERIFIED`,
- Abwesenheit einer terminalen #226-`COMPLETED`-Evidence.

Er liefert nur dann:

```text
status=LIVE_HANDOFF_VERIFIED
serviceCutoverPlanningAllowed=true
runtimeConfigurationChanged=true
activationExecuted=false
liveRuntimeAttested=false
```

## Abgrenzung zu synthetischem #226-COMPLETED

Der #226-Contract darf weiterhin mit einem expliziten synthetischen Checker seine atomare Transaktionslogik testen und dabei `COMPLETED` erzeugen.

Ein solcher terminaler Marker ist **kein** zulässiger Produktions-Handoff und wird vom neuen read-only Verifier als Konflikt blockiert.

Damit bleibt die Aussage eindeutig:

```text
Target-.env erfolgreich geschrieben != produktive Aktivierung abgeschlossen
```

## CI-Vertrag

Der Contract verwendet zunächst den bestehenden #226-Test, um echte signierte Drill-/Attestation-Prerequisites zu erzeugen. Danach werden frische Plan-v2/PENDING-Cases aufgebaut und geprüft:

- kanonischer Boundary-Befund -> signierter nichtterminaler Handoff,
- nicht zielbezogene Env-Secrets bleiben unverändert und gelangen nicht in Evidence,
- Handoff-Verifier erlaubt Service-Cutover-Planung, aber keine terminale Aktivierung,
- Retry ist byte-stabil,
- Crash nach Target-Write wird ohne zweiten Write recovered,
- unerwarteter Target-Validation-Fehler führt weiter zu signiertem bytegenauem Rollback,
- Handoff-Tampering blockiert,
- synthetisches #226-COMPLETED wird nicht als Handoff akzeptiert.

## Nächster Slice

Der nächste sichere Slice stellt den bereits gemergten #227-Service-Cutover-Plan von terminaler #226-Completion auf dieses signierte Handoff um.

Erst danach folgt die separate signierte Live-Baseline der noch DISABLED laufenden Container. Ohne Handoff **und** Live-Baseline darf kein Service-Recreate stattfinden.

`.env.example` und die praktischen Restore-/RTO-Gates bleiben unverändert DISABLED/offen.
