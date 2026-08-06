#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
ENV_FILE="${ROOT_DIR}/.env"
LOCK_FILE="${MASTER_DIAGNOSTICS_BACKUP_LOCK_FILE:-/tmp/master-diagnostics-backup.lock}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; copy .env.example and configure the club deployment first." >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for serialized club backups." >&2
  exit 1
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another master-diagnostics backup is already running." >&2
  exit 1
fi

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
stack_stopped=0

restart_stack() {
  if [[ "${stack_stopped}" -eq 1 ]]; then
    echo "Restarting club stack after backup attempt..." >&2
    "${compose[@]}" up -d
  fi
}
trap restart_stack EXIT INT TERM

# Build the helper before downtime begins.
"${compose[@]}" --profile backup build backup-bundle

# Stop external traffic and every process that can mutate protected volumes before libSQL.
"${compose[@]}" stop -t 30 caddy app export-cleanup retention-scan
"${compose[@]}" stop -t 45 libsql
stack_stopped=1

# The helper sees only read-only protected volumes, the key file and the backup target.
"${compose[@]}" --profile backup run --rm --no-deps backup-bundle

# Restore the regular profile only after the encrypted bundle completed successfully.
"${compose[@]}" up -d
stack_stopped=0
trap - EXIT INT TERM
