# Sicherheitsgrundsätze

- TLS für jede Installation jenseits von localhost
- Secrets nie im Image oder Repository
- sichere Cookies, CSRF-Schutz, CSP und Rate Limiting
- kein direkter Datenbankzugriff aus dem Browser
- erneute Authentifizierung für sensible Exporte
- Plattform-Admins ohne regulären Zugriff auf Diagnostikdaten
- Standardlogs enthalten keine Messwerte oder Freitexte
- vollständige Tenant-Isolation durch Negativtests
