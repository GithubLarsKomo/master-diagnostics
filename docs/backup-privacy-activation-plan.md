# Backup Privacy Activation Plan v1

## Zweck

Der Activation Plan ist die letzte **pre-mutation** Evidence vor einer späteren Umschaltung der Backup-Privacy-Runtime-Attestation.

Er konsumiert ausschließlich eine gültige signierte Manual-Attestation aus #222 und beschreibt bytegenau, welche `.env`-Datei von welchem Inhalt auf welchen Zielinhalt wechseln darf. Der Plan selbst ändert die Datei nicht.

## Sicherheitsziel

Ein späterer Executor darf nicht aus dem aktuellen Dateizustand raten, was ursprünglich autorisiert war. Deshalb bindet der Plan:

- `attestationId` und `attestationFingerprint`,
- SHA-256 des vollständigen Attestation-Artefakts,
- absoluten Pfad der Ziel-`.env`,
- SHA-256 des aktuellen `.env`-Bytestrings,
- SHA-256 des exakt geplanten Ziel-Bytestrings,
- die fünf Policy-v1-Zielwerte,
- `expectedPreState=DISABLED`,
- `expectedPostState=ENABLED`,
- Pflicht zu atomarem Replace,
- Pflicht zu Post-Write-Runtime-Attestation,
- Pflicht zu Rollback bei Validierungsfehler.

`runtimeConfigurationChanged=false` und `activationExecuted=false` sind im Plan fest.

## Zielwerte

```dotenv
PRIVACY_BACKUP_STATE=ENABLED
PRIVACY_BACKUP_POLICY_VERSION=1.0.0
PRIVACY_BACKUP_ENCRYPTED_AT_REST=true
PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true
PRIVACY_BACKUP_RESTORE_RECONCILIATION=true
```

Andere `.env`-Zeilen werden byte-/zeilenlogisch erhalten. Bereits vorhandene Zielvariablen werden an ihrer Position ersetzt; fehlende Zielvariablen werden in fester Reihenfolge angehängt.

## Voraussetzungen

Die Planung blockiert, wenn:

- die #222-Attestation nicht verifiziert werden kann,
- die Attestation nicht exakt Policy v1 autorisiert,
- `PRIVACY_BACKUP_STATE` in der Ziel-`.env` nicht exakt `DISABLED` ist,
- eine der fünf Zielvariablen mehrfach vorkommt,
- eine Zielvariable keine einfache `KEY=VALUE`-Zeile ist,
- `.env`, Schlüssel oder Planpfade Symlinks/unsicher sind,
- die `.env` gruppen-/weltweit schreibbar ist.

## Plan erzeugen

```bash
python3 infra/backup/prepare-backup-privacy-activation-plan.py \
  --attestation-checker "$PWD/infra/backup/check-backup-privacy-manual-attestation.py" \
  --attestation /var/lib/master-diagnostics/backup-privacy-attestations/attestation-<32-hex>.json \
  --key-file /etc/master-diagnostics/backup-privacy-manual-attestation.key \
  --env-file /path/to/deployment/.env \
  --output-dir /var/lib/master-diagnostics/backup-privacy-activations
```

Der `activationId` wird deterministisch aus Attestation-, Env- und Zielbindung abgeleitet. Ein identischer Retry verwendet denselben Plan wieder; ein anderer Ausgangszustand erzeugt bewusst eine andere Planidentität.

## Plan verifizieren

```bash
python3 infra/backup/check-backup-privacy-activation-plan.py \
  --plan /var/lib/master-diagnostics/backup-privacy-activations/activation-<32-hex>.json \
  --key-file /etc/master-diagnostics/backup-privacy-manual-attestation.key
```

Nur ein gültiger Plan liefert:

```text
ACTIVATION_PLAN_VERIFIED
activationExecutionAllowed=true
runtimeConfigurationChanged=false
activationExecuted=false
```

Die Signatur verwendet dieselbe Schlüsseldatei wie die manuelle Attestation, aber eine getrennte HMAC-Domain:

```text
masters:backup-privacy-activation-plan:v1
```

## Crash-/Retry-Vertrag für den späteren Executor

Ein späterer Executor muss vor jeder Mutation den tatsächlichen `.env`-Fingerprint mit dem Plan vergleichen:

- entspricht er `currentEnvFingerprint`: Mutation darf erst beginnen,
- entspricht er `targetEnvFingerprint`: die Dateiumschaltung ist bereits erfolgt und darf nicht erneut blind geschrieben werden,
- entspricht er keinem der beiden Werte: **BLOCKED / DRIFT**, keine automatische Reparatur.

Nach einem Replace muss die globale Runtime-Privacy-Attestation mit dem neuen Zustand erfolgreich sein. Bei Validierungsfehler muss auf den plan-gebundenen Ausgangsbytestring zurückgerollt werden.

## CI-Grenze

Der Contract arbeitet nur mit temporären Env-Dateien. Er beweist:

- echte #220/#221/#222-Evidence-Kette bis zum Plan,
- Byte-Unverändertheit der `.env` während Planung,
- unabhängige Berechnung des Ziel-Fingerprints,
- idempotenten Retry,
- Blockade bei bereits aktivem oder mehrdeutigem Env-Zustand,
- HMAC-/Fingerprint-Tamper-Blockade,
- unveränderte Release-/RTO-Gates.

Ein grüner CI-Lauf aktiviert keine reale Installation.

## Nächster Slice

Der nachgelagerte Executor darf erst auf Basis dieses verifizierten Plans eine atomare Env-Umschaltung durchführen. Er muss Pre-/Post-Fingerprint, Runtime-Attestation und Rollback als eine crash-/retry-fähige Transaktion behandeln.
