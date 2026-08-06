#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/verify-club-backup.sh <bundle-file.mdbak>" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; copy .env.example and configure the club deployment first." >&2
  exit 1
fi

bundle_file="$1"
if [[ "${bundle_file}" != "$(basename -- "${bundle_file}")" || ! "${bundle_file}" =~ ^masters-backup-[A-Za-z0-9._-]+\.mdbak$ ]]; then
  echo "Bundle argument must be one generated .mdbak file name without a path." >&2
  exit 2
fi

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
"${compose[@]}" --profile backup build backup-verify
"${compose[@]}" --profile backup run --rm --no-deps \
  -e "BACKUP_BUNDLE_FILE=/backup-target/${bundle_file}" \
  -e "BACKUP_CHECKSUM_FILE=/backup-target/${bundle_file}.sha256" \
  backup-verify
