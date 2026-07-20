# Autarker Club-Modus

## Eigenschaften

- genau ein Tenant
- Better Auth
- lokaler libSQL-Container
- Betrieb ohne Internet
- Docker Compose und Caddy

## Start

```bash
cp .env.example .env
# Secrets und APP_HOST setzen
docker compose -f infra/docker-compose.club.yml up -d --build
```

Der Setup-Assistent ist noch zu implementieren. Bis dahin ist dieses Deployment nur ein technisches Grundgerüst.
