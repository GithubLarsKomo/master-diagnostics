# Backup Privacy Service Live Runtime Attestation

## Zweck

Nach #244 kann die Service-Cutover-State-Machine zuverlässig entscheiden, ob ein Target- oder Rollback-Pfad fortgesetzt werden darf. Für `LIVE_VALIDATED` bzw. `ROLLBACK_VERIFIED` wurde bislang jedoch lediglich der SHA-256 eines privaten JSON-Attestation-Artefakts gebunden.

Dieser Slice macht dieses Artefakt selbst HMAC-signiert und bindet es an die aktuelle Cutover-/Baseline-/Journal-Kette sowie an eine privacy-begrenzte Darstellung des tatsächlichen Runtime-Istzustands.

Der Slice bleibt read-only. Er ruft weder Docker noch Compose auf und führt keine Service- oder `.env`-Mutation aus. Die Inspect-Evidence wird vom späteren Host-Executor read-only gesammelt und übergeben.

## Signing Domain

```text
masters:backup-privacy-service-live-runtime-attestation:v1
```

Das Dokument bleibt absichtlich kompatibel mit der bestehenden #244-State-Machine und trägt top-level:

```text
status=VERIFIED
backupState=ENABLED|DISABLED
```

Damit bindet das bestehende Execution-Event weiterhin den SHA-256 der **vollständigen signierten Datei**.

## Verifikation vor Erstellung

Vor einer Attestation werden erneut geprüft:

- HMAC und Fingerprint des Service-Cutover-Plans v2,
- HMAC und Bindung der Live-Baseline v2,
- SHA-gebundene unabhängige `SERVICE_LIVE_BASELINE_VERIFIED`-Ausgabe,
- HMAC und Bindung des Execution-Journals v2,
- vollständige Execution-Event-Kette,
- aktueller bounded Inspect-State über die #244-Klassifikation,
- Preserve-, Health- und Volume-Invarianten.

Für `ENABLED` ist nur ein echter `TARGET`-Live-State in einem passenden Execution-Zustand attestierbar. Für `DISABLED` muss der Runtime-State `BASELINE` oder `ROLLBACK` sein und die State-Machine im Rollback-Verifikationspfad stehen.

## Gebundene Evidence

Die signierte Record-Struktur bindet unter anderem:

- Activation-, Cutover- und Baseline-ID,
- Cutover-Plan-, Baseline-, Target-Handoff- und Journal-Fingerprint,
- Execution-Assessment-Status, Eventzahl und letzte Phase,
- erwarteten Backup-State,
- Container-/Image-Identität aller fünf Services,
- Running-/Health-Zustand,
- ausschließlich die gefilterte Backup-Privacy-Environment der drei mutable Services,
- vier Anwendungsdaten-Volumes,
- Caddy Data und Caddy Config,
- Fingerprint dieser bounded Live-Evidence.

Nicht-Privacy-Environment-Werte und Secrets werden nicht in die signierte Evidence übernommen oder gehasht.

## Prepare und Check

`prepare` persistiert das signierte private Artefakt mit `0600` unter einem privaten `0700`-Verzeichnis.

`check` verifiziert HMAC und Fingerprints und führt anschließend die gesamte aktuelle Evidence-Kette erneut aus. Die aktuelle bounded Runtime-Evidence muss der signierten Evidence entsprechen.

Das erlaubt dem späteren Host-Executor den sicheren Ablauf:

```text
current read-only inspect collection
  -> signed live-runtime attestation
  -> independent attestation check
  -> Execution event LIVE_VALIDATED / ROLLBACK_VERIFIED
```

## Noch kein Host-Cutover

Dieser Slice führt selbst keine Docker-Mutation aus und ist kein praktischer Restore-/RTO-Nachweis. `.env.example` bleibt `PRIVACY_BACKUP_STATE=DISABLED`; die realen Release-Gates bleiben offen.

## Nächster Slice

Der bounded Host-Executor muss unmittelbar vor dem jeweiligen Validation-Event sowohl das signierte Attestation-Artefakt als auch dessen unabhängigen Checker gegen frisch gesammelte Inspect-Evidence ausführen. Erst danach darf er `LIVE_VALIDATED` bzw. `ROLLBACK_VERIFIED` persistieren.