# Backup-Grundkonzept

Der produktive Backup-Job wird in Epic 12 implementiert. Verbindliche Anforderungen:

- täglicher konsistenter libSQL-Snapshot
- Verschlüsselung vor Ablage
- 30 tägliche Sicherungen als Standard
- lokales/NAS-Ziel, optional S3-kompatibel
- Integritätsprüfung und protokollierter Restore-Test

Keine unverschlüsselten Produktivdaten in dieses Repository einchecken.
