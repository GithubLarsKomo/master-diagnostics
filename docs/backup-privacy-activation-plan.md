# Backup Privacy Activation Plan v2

## Zweck

Der Activation Plan ist die letzte **pre-mutation** Evidence vor einer späteren Umschaltung der Backup-Privacy-Runtime-Attestation. Plan v2 ersetzt v1 bewusst: v1 band zwar Ausgangs- und Ziel-Hash, enthielt aber noch nicht genügend Information, um nach einem Prozess-Crash und fehlgeschlagener Post-Validation den exakten Ausgangszustand ohne Raten wiederherzustellen.

Der Plan selbst ändert weiterhin keine `.env`.

## Byte-reversibler Vertrag

Plan v2 bindet weiterhin:

- `attestationId` und `attestationFingerprint`,
- SHA-256 des vollständigen Attestation-Artefakts,
- absoluten Pfad der Ziel-`.env`,
- SHA-256 des aktuellen `.env`-Bytestrings,
- SHA-256 des exakt geplanten Ziel-Bytestrings,
- die fünf Policy-v1-Zielwerte,
- `expectedPreState=DISABLED`,
- `expectedPostState=ENABLED`.

Zusätzlich enthält `rollbackDescriptor` ausschließlich reversible Metadaten der fünf erlaubten Backup-Privacy-Variablen:

- ob die Zeile ursprünglich vorhanden war,
- ursprüngliche Zeilenposition,
- ursprünglicher Wert,
- ursprünglicher Zeilenabschluss (`LF`, `CRLF` oder kein Abschluss),
- Zielwert,
- bei neu angehängten Variablen die Zielzeilenposition,
- ob die Originaldatei mit einem Zeilenabschluss endete.

Andere `.env`-Werte – insbesondere Secrets – werden **nicht** in den Plan kopiert.

Die Policy-Flags verlangen:

```text
atomicReplaceRequired=true
postWriteRuntimeAttestationRequired=true
rollbackOnValidationFailureRequired=true
exactRollbackReconstructionRequired=true
nonTargetEnvBytesMustRemainUnchanged=true
```

## Zielwerte

```dotenv
PRIVACY_BACKUP_STATE=ENABLED
PRIVACY_BACKUP_POLICY_VERSION=1.0.0
PRIVACY_BACKUP_ENCRYPTED_AT_REST=true
PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true
PRIVACY_BACKUP_RESTORE_RECONCILIATION=true
```

Vorhandene Zielzeilen werden unter Beibehaltung ihres Zeilenabschlusses ersetzt. Fehlende Zielzeilen werden in fester Reihenfolge angehängt. Eine Datei ohne finalen Newline kann exakt wiederhergestellt werden.

Gemischte `LF`-/`CRLF`-Dateien werden fail-closed blockiert, weil für neu anzuhängende Zeilen sonst keine eindeutige kanonische Wahl besteht. Reine LF- und reine CRLF-Dateien werden unterstützt.

## Signatur und Versionierung

Plan v2 verwendet eine neue HMAC-Domain:

```text
masters:backup-privacy-activation-plan:v2
```

Ein v1-Plan darf deshalb nicht stillschweigend als reversibler v2-Plan interpretiert werden.

## Crash-/Retry-Vertrag

Ein späterer Executor vergleicht zuerst den tatsächlichen `.env`-Fingerprint:

- `currentEnvFingerprint` → noch nicht umgeschaltet; Mutation darf nach weiterer Execution-Evidence beginnen,
- `targetEnvFingerprint` → Dateiumschaltung ist bereits erfolgt; nicht blind erneut schreiben, sondern Post-Validation fortsetzen,
- anderer Fingerprint → `BLOCKED / DRIFT`.

Wenn die Post-Validation scheitert, kann der Executor aus Ziel-`.env` plus `rollbackDescriptor` ausschließlich die fünf gebundenen Änderungen rückwärts anwenden. Der rekonstruierte Bytestring muss anschließend exakt `currentEnvFingerprint` ergeben. Erst dann darf er atomar zurückgeschrieben werden.

## Sicherheitsgrenzen

Planung blockiert unter anderem bei:

- ungültiger #222-Attestation,
- Backup-State ungleich exakt `DISABLED`,
- doppelten oder nicht-kanonischen Zielvariablen,
- unsicheren Datei-/Schlüsselpfaden,
- gruppen-/weltweit schreibbarer `.env`,
- CR-only oder gemischten LF/CRLF-Zeilenenden.

`runtimeConfigurationChanged=false` und `activationExecuted=false` bleiben im Plan fest.

## CI

Zusätzlich zum bestehenden Activation-Plan-Contract prüft der Reversible-Plan-Contract:

- exakte Roundtrip-Wiederherstellung für LF,
- exakte Roundtrip-Wiederherstellung für CRLF,
- fehlende Zielvariablen,
- ursprüngliche Datei ohne finalen Newline,
- Blockade gemischter Zeilenenden,
- dass keine übrigen `.env`-Secrets in den Rollback-Descriptor aufgenommen werden,
- weiterhin keine `os.replace`-/Docker-Mutation im Planer.

Ein grüner CI-Lauf aktiviert keine reale Installation.

## Nächster Slice

Der nächste Slice kann nun die eigentliche Activation-Execution-Evidence und danach den atomaren Env-Executor implementieren. Er muss Plan-v2-Verifikation, Pre-/Post-Fingerprint, Post-Write-Runtime-Attestation und bytegenauen Rollback als crash-/retry-fähige Zustandsmaschine behandeln.
