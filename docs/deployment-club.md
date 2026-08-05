# Autarker Club-Modus

## Eigenschaften

- genau ein Tenant
- Better Auth
- lokaler libSQL-Container mit persistentem Volume
- persistente Volumes für Reports, Tenant-Exporte und verschlüsselte Betroffenenexportpakete
- automatische Datenbankmigration vor dem App-Start
- fail-closed Privacy-Capability-Preflight vor dem App-Start
- stündlicher Cleanup ephemerer Tenant-/Betroffenenexportpakete
- Docker Compose und Caddy mit automatischem TLS
- Betrieb der Anwendung ohne externe Datenbank

## Voraussetzungen

- Linux-Server mit Docker Engine und Docker Compose v2
- DNS-Eintrag des gewünschten Hostnamens auf die Server-IP
- eingehende Ports 80 und 443
- mindestens 2 GB RAM für den ersten Testbetrieb

## Erstes Deployment

```bash
git clone https://github.com/GithubLarsKomo/master-diagnostics.git
cd master-diagnostics
cp .env.example .env
```

In `.env` mindestens setzen:

```dotenv
APP_HOST=diagnostics.example.org
NEXT_PUBLIC_APP_URL=https://diagnostics.example.org
BETTER_AUTH_URL=https://diagnostics.example.org
BETTER_AUTH_SECRET=<mit openssl rand -base64 48 erzeugen>

# Solange diese externen Funktionen tatsächlich nicht eingesetzt werden:
PRIVACY_BACKUP_STATE=DISABLED
PRIVACY_NOTIFICATIONS_STATE=DISABLED
```

Die Privacy-Zustände sind keine Feature-Schalter, sondern eine explizite Laufzeit-Attestation. Ein fehlender Wert ist deshalb **nicht** gleichbedeutend mit `DISABLED` und blockiert den App-Start im Club-Compose.

Wird Backup oder Notification später produktiv aktiviert, darf der jeweilige Zustand erst auf `ENABLED` wechseln, wenn alle zugehörigen versionierten Kontrollvariablen aus `.env.example` den tatsächlich implementierten Betrieb beschreiben. Eine nur teilweise ausgefüllte oder veraltete Attestation schlägt fail-closed fehl.

Vor dem Compose-Start kann derselbe Vertrag separat geprüft werden:

```bash
pnpm install --frozen-lockfile
pnpm privacy-capabilities:check
```

Das Kommando gibt nur Zustände, erwartete Policy-Versionen und strukturierte Blocker aus. Es gibt keine Secrets oder vollständigen Environment-Werte aus und beendet sich bei nicht erfüllter Attestation mit Exit-Code ungleich `0`.

Danach Konfiguration prüfen und starten:

```bash
docker compose -f infra/docker-compose.club.yml config --quiet
docker compose -f infra/docker-compose.club.yml up -d --build
docker compose -f infra/docker-compose.club.yml ps
```

Die Startreihenfolge ist fest definiert:

1. libSQL wird gestartet und muss gesund sein.
2. Der einmalige `migrate`-Container spielt alle Migrationen ein.
3. Der einmalige `privacy-check`-Container validiert die globale Backup-/Notification-Attestation aus `.env`.
4. Die Web-App startet erst, wenn Migration und Privacy-Preflight erfolgreich beendet sind, und beantwortet `/api/health`.
5. Der `export-cleanup`-Container startet nach erfolgreicher Migration und pflegt Tenant- sowie Betroffenenexportpakete stündlich.
6. Caddy veröffentlicht die Anwendung und beschafft das TLS-Zertifikat.

Ein Upgrade von einem älteren Stand benötigt deshalb vor `up -d --build` mindestens die beiden expliziten `PRIVACY_*_STATE`-Deklarationen. Fehlen sie, ist ein blockierter App-Start das beabsichtigte Verhalten.

## Persistente Privacy-Artefakte

Der Club-Stack bindet folgende Docker-Volumes ein:

- `libsql-data` → Datenbank,
- `report-data` → Report-PDFs,
- `export-data` → verschlüsselte vollständige Tenant-Exportpakete (`.mde`),
- `data-subject-delivery-data` → verschlüsselte Betroffenenexportpakete (`.mdse`).

App und Maintenance-Container verwenden für `.mdse` denselben Pfad `/var/lib/masters/data-subject-delivery-packages`. Dadurch überstehen noch auslieferbare Pakete einen App-Neustart und die in Policy 1.6 verwendete Anonymisierungs-Quarantäne arbeitet auf demselben persistenten Storage.

Bei regulären Updates dürfen diese Volumes nicht mit `docker compose down -v` entfernt werden.

## Verifikation

```bash
curl --fail https://diagnostics.example.org/api/health
docker compose -f infra/docker-compose.club.yml logs --tail=100 migrate privacy-check export-cleanup app caddy
```

Erwartet werden eine erfolgreiche Health-Antwort, mit Status `0` beendete `migrate`- und `privacy-check`-Container sowie ein laufender `export-cleanup`-Container.

## Betrieb

```bash
# Status
docker compose -f infra/docker-compose.club.yml ps

# Logs
docker compose -f infra/docker-compose.club.yml logs -f app

# Privacy-Attestation erneut prüfen
docker compose -f infra/docker-compose.club.yml run --rm privacy-check

# Export-Maintenance beobachten
docker compose -f infra/docker-compose.club.yml logs -f export-cleanup

# Aktualisierung
git pull --ff-only
docker compose -f infra/docker-compose.club.yml up -d --build

# Stoppen ohne Datenverlust
docker compose -f infra/docker-compose.club.yml down
```

`export-cleanup` führt in jedem Zyklus zuerst den Cleanup abgelaufener Tenant-Exporte und danach den Cleanup konsumierter/abgelaufener Betroffenenexportpakete aus. Schlägt einer der beiden Schritte fehl, beendet sich der Container und wird durch `restart: unless-stopped` erneut gestartet; der Fehler wird nicht als scheinbar erfolgreicher Maintenance-Zyklus verschluckt.

Vor einem produktiven Einsatz müssen Backup und Restore aus `infra/backup/README.md` praktisch getestet werden. Sobald ein Backup-System tatsächlich aktiviert wird, muss dessen reale Betriebsimplementierung zusätzlich den versionierten Privacy-Vertrag aus `docs/global-privacy-policy.md` erfüllen; `PRIVACY_BACKUP_STATE=ENABLED` ist keine bloße Selbstdeklaration ohne die dort geforderten Kontrollen.
