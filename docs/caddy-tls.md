# Caddy TLS im Club-Modus

## Ziel

Der Club-Stack veröffentlicht die Anwendung über Caddy. Dieser Betriebsvertrag unterscheidet ausdrücklich zwei TLS-Modi:

1. **öffentlich erreichbarer DNS-Hostname** mit Caddys automatischem ACME-TLS,
2. **rein internes Netz** mit Caddys eigener interner CA (`tls internal`).

Der Repository-Standard bleibt öffentliches automatisches TLS. `tls internal` ist eine bewusste lokale Betriebsvariante und darf nicht stillschweigend aktiviert werden.

## Repository-Standard: öffentliches automatisches TLS

Die kanonische `infra/caddy/Caddyfile` verwendet:

```caddy
{$APP_HOST:localhost} {
  reverse_proxy app:3000
  encode zstd gzip
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
  }
}
```

Bei einem öffentlich auflösbaren `APP_HOST` und erreichbaren Ports 80/443 beschafft und erneuert Caddy das Zertifikat automatisch. Dafür müssen:

- `APP_HOST` auf den vorgesehenen Server zeigen,
- TCP 80/443 von außen erreichbar sein,
- kein anderer Dienst diese Ports belegen,
- `caddy-data` und `caddy-config` persistent erhalten bleiben.

Die TLS-Automation darf nicht durch `docker compose down -v` oder das Löschen der Caddy-Volumes zerstört werden.

## Interner Club-Hostname

Für einen Hostnamen, der ausschließlich im internen Netz existiert und nicht per öffentlichem ACME validierbar ist, kann Caddy mit seiner internen CA arbeiten. Die Variante lautet beispielsweise:

```caddy
{$APP_HOST:diagnostics.club.internal} {
  tls internal
  reverse_proxy app:3000
  encode zstd gzip
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
  }
}
```

Diese Änderung ist eine bewusste Deployment-Anpassung. Sie gehört in eine installationsspezifische Caddy-Konfiguration oder einen nachvollziehbaren Repository-Change; sie soll nicht durch Laufzeit-Skripte automatisch umgeschrieben werden.

## Vertrauenskette bei `tls internal`

Caddys interne CA ist nicht automatisch auf den Browser-/Betriebssystemen der Clients vertrauenswürdig. Der Root-CA-Nachweis muss kontrolliert verteilt werden.

Auf dem Server kann die Root-CA aus dem persistenten Caddy-Datenvolume gelesen werden. Der genaue interne Storage-Pfad ist eine Caddy-Implementierungsdetails; deshalb sollte vor einer Verteilung zunächst der laufende Container bzw. das Volume inspiziert und der tatsächlich verwendete Root-CA-Pfad bestätigt werden.

Für verwaltete Clients ist die bevorzugte Verteilung:

- Windows: zentrale Zertifikatverteilung bzw. lokaler Import in **Trusted Root Certification Authorities**,
- macOS/iOS: MDM-/Konfigurationsprofil oder kontrollierter Import in den System-Schlüsselbund,
- Linux: distributionseigener Trust-Store,
- Firefox: je nach Enterprise-Konfiguration System-Trust oder eigener NSS-Store.

Die Root-CA darf nur als **öffentliches Zertifikat** verteilt werden. Private Schlüssel der Caddy-CA dürfen den Server bzw. das geschützte Caddy-Datenvolume nicht verlassen.

## Persistenz und Backup

Der Club-Compose-Stack verwendet zwei persistente Caddy-Volumes:

- `caddy-data` → Zertifikate, ACME-/CA-Zustand und weitere persistente Caddy-Daten,
- `caddy-config` → persistente Caddy-Konfiguration/Runtime-State.

Für Restore und Migration gilt:

- beide Volumes zusammen behandeln,
- niemals einzelne private CA-Schlüssel aus dem Volume separat kopieren oder verteilen,
- Dateirechte und Docker-Volume-Eigentum beibehalten,
- nach einem Restore Caddy starten und anschließend den TLS-Handshake gegen den vorgesehenen Hostnamen prüfen.

Das bestehende Backup-System nimmt `caddy-data` und `caddy-config` in das verschlüsselte Backup-Bundle auf. Ein Restore-Drill soll deshalb auch prüfen, dass ein wiederhergestellter Caddy-Zustand weiterhin einen gültigen TLS-Endpunkt liefert.

## Rotation und Verlust der internen CA

Bei öffentlichem ACME-TLS übernimmt Caddy die normale Zertifikatserneuerung automatisch.

Bei `tls internal` ist der Root-CA-Schlüssel eine lokale Vertrauenswurzel. Geht er verloren und wird eine neue interne CA erzeugt, müssen alle Clients der neuen Root-CA erneut vertrauen. Eine absichtliche Rotation sollte deshalb als kontrollierter Betriebswechsel erfolgen:

1. neue CA auf einer isolierten/testbaren Installation erzeugen,
2. neues Root-Zertifikat kontrolliert an verwaltete Clients verteilen,
3. Client-Vertrauen verifizieren,
4. Caddy-Produktionszustand umstellen,
5. alten Trust erst nach bestätigter Migration entfernen.

Ein stiller Austausch der internen CA ist nicht zulässig, weil er sonst wie ein TLS-Ausfall auf allen Clients erscheint.

## Verifikation

### Öffentliches TLS

```bash
curl --fail --show-error --head "https://${APP_HOST}/api/health"
openssl s_client -connect "${APP_HOST}:443" -servername "${APP_HOST}" </dev/null
```

Erwartet werden eine erfolgreiche TLS-Verbindung, ein Zertifikat für den konfigurierten Hostnamen und eine erfolgreiche Health-Antwort.

### Internes TLS

Vor Installation des Root-Zertifikats muss ein unvertrauenswürdiger Client die lokale CA erwartbar ablehnen. Nach kontrollierter Trust-Installation muss derselbe HTTPS-Aufruf ohne Zertifikatswarnung funktionieren.

Zusätzlich auf dem Host:

```bash
docker compose -f infra/docker-compose.club.yml ps caddy
docker compose -f infra/docker-compose.club.yml logs --tail=100 caddy
```

Caddy muss laufen; Zertifikats-/ACME- oder CA-Fehler dürfen nicht als erfolgreiches Deployment akzeptiert werden.

## Sicherheitsgrenzen

- TLS darf nicht durch `http://` als dauerhafte Produktionslösung umgangen werden.
- Private CA-Schlüssel werden niemals an Clients verteilt.
- `caddy-data` und `caddy-config` sind produktive Sicherheitsartefakte und dürfen nicht mit `down -v` gelöscht werden.
- Ein interner Root-CA-Trust ist eine administrative Sicherheitsentscheidung; er darf nicht durch die Web-App selbst installiert werden.
- Änderungen am TLS-Modus werden wie andere Infrastrukturänderungen reviewt und durch vollständige CI sowie einen Deployment-/Restore-Test abgesichert.
