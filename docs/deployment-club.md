# Autarker Club-Modus

## Eigenschaften

- genau ein Tenant
- Better Auth
- lokaler libSQL-Container mit persistentem Volume
- automatische Datenbankmigration vor dem App-Start
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
```

Danach Konfiguration prüfen und starten:

```bash
docker compose -f infra/docker-compose.club.yml config --quiet
docker compose -f infra/docker-compose.club.yml up -d --build
docker compose -f infra/docker-compose.club.yml ps
```

Die Startreihenfolge ist fest definiert:

1. libSQL wird gestartet und muss gesund sein.
2. Der einmalige `migrate`-Container spielt alle Migrationen ein.
3. Die Web-App startet und beantwortet `/api/health` erfolgreich.
4. Caddy veröffentlicht die Anwendung und beschafft das TLS-Zertifikat.

## Verifikation

```bash
curl --fail https://diagnostics.example.org/api/health
docker compose -f infra/docker-compose.club.yml logs --tail=100 migrate app caddy
```

Erwartet wird eine erfolgreiche Health-Antwort und ein mit Status `0` beendeter Migrationscontainer.

## Betrieb

```bash
# Status
docker compose -f infra/docker-compose.club.yml ps

# Logs
docker compose -f infra/docker-compose.club.yml logs -f app

# Aktualisierung
git pull --ff-only
docker compose -f infra/docker-compose.club.yml up -d --build

# Stoppen ohne Datenverlust
docker compose -f infra/docker-compose.club.yml down
```

Das Volume `libsql-data` enthält die Datenbank und darf bei regulären Updates nicht gelöscht werden. Vor einem produktiven Einsatz müssen Backup und Restore aus `infra/backup/README.md` praktisch getestet werden.
