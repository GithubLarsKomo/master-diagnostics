#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SYSTEMD_DIR="${MASTER_DIAGNOSTICS_SYSTEMD_DIR:-/etc/systemd/system}"
SKIP_SYSTEMCTL="${MASTER_DIAGNOSTICS_SKIP_SYSTEMCTL:-0}"
SERVICE_PATH="${SYSTEMD_DIR}/master-diagnostics-postgres-backup.service"
TIMER_PATH="${SYSTEMD_DIR}/master-diagnostics-postgres-backup.timer"

if [[ ! -f "${ROOT_DIR}/.env" ]]; then
  echo "Missing ${ROOT_DIR}/.env" >&2
  exit 1
fi
if [[ "${ROOT_DIR}" =~ [[:space:]%] ]]; then
  echo "Repository path must not contain whitespace or %" >&2
  exit 1
fi
if [[ "${SYSTEMD_DIR}" == "/etc/systemd/system" && "${EUID}" -ne 0 ]]; then
  echo "Run as root or set MASTER_DIAGNOSTICS_SYSTEMD_DIR for verification" >&2
  exit 1
fi

install -d -m 0755 "${SYSTEMD_DIR}"
cat >"${SERVICE_PATH}" <<EOF
[Unit]
Description=Master Diagnostics encrypted PostgreSQL backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=${ROOT_DIR}
ExecStart=/usr/bin/env bash ${ROOT_DIR}/infra/backup/create-club-postgres-backup.sh
EOF

cat >"${TIMER_PATH}" <<'EOF'
[Unit]
Description=Daily Master Diagnostics encrypted PostgreSQL backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
Unit=master-diagnostics-postgres-backup.service

[Install]
WantedBy=timers.target
EOF
chmod 0644 "${SERVICE_PATH}" "${TIMER_PATH}"

if [[ "${SKIP_SYSTEMCTL}" == "1" ]]; then
  printf '%s\n' "${SERVICE_PATH}" "${TIMER_PATH}"
  exit 0
fi

systemctl daemon-reload
systemctl enable --now master-diagnostics-postgres-backup.timer
systemctl status --no-pager master-diagnostics-postgres-backup.timer
