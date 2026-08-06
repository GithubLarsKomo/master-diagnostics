#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/stage-club-restore.sh masters-backup-<timestamp>-<uuid>.mdbak" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi

bundle_name="$1"
if [[ ! "${bundle_name}" =~ ^masters-backup-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdbak$ ]]; then
  echo "Backup file name is invalid." >&2
  exit 2
fi

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
"${compose[@]}" --profile backup build backup-restore-stage
"${compose[@]}" --profile backup run --rm --no-deps \
  -e "BACKUP_BUNDLE_FILE=/backup-target/${bundle_name}" \
  -e "BACKUP_CHECKSUM_FILE=/backup-target/${bundle_name}.sha256" \
  backup-restore-stage
