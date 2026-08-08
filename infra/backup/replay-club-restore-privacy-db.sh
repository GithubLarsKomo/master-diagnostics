#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/replay-club-restore-privacy-db.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi

staging_name="$1"
if [[ ! "${staging_name}" =~ ^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Restore staging name is invalid." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

staging_root="${RESTORE_STAGING_HOST_DIR:-/var/lib/master-diagnostics/restore-staging}"
replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
source_root="${staging_root}/${staging_name}"
manifest_path="${source_root}/manifest.json"
workspace="${replay_root}/${staging_name}"
required_sources=(libsql reports tenant-exports data-subject-delivery)

if [[ ! -f "${manifest_path}" ]]; then
  echo "Restore staging is incomplete: ${staging_name}" >&2
  exit 1
fi
for source_name in "${required_sources[@]}"; do
  if [[ ! -d "${source_root}/${source_name}" ]]; then
    echo "Restore staging source is missing: ${source_name}" >&2
    exit 1
  fi
done

mkdir -p "${replay_root}"
chmod 0700 "${replay_root}"
if [[ ! -d "${workspace}" ]]; then
  if [[ -e "${workspace}" ]]; then
    echo "Restore privacy replay workspace exists but is incomplete: ${workspace}" >&2
    exit 1
  fi
  tmp_workspace="${replay_root}/.${staging_name}.$$.tmp"
  trap 'rm -rf -- "${tmp_workspace:-}"' EXIT
  mkdir -m 0700 "${tmp_workspace}"
  for source_name in "${required_sources[@]}"; do
    cp -a -- "${source_root}/${source_name}" "${tmp_workspace}/${source_name}"
  done
  mv -- "${tmp_workspace}" "${workspace}"
  trap - EXIT
else
  for source_name in "${required_sources[@]}"; do
    if [[ ! -d "${workspace}/${source_name}" ]]; then
      echo "Restore privacy replay workspace exists but is incomplete: ${workspace}/${source_name}" >&2
      exit 1
    fi
  done
fi
chmod 0700 "${workspace}"

export RESTORE_STAGING_NAME="${staging_name}"
compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
cleanup() {
  "${compose[@]}" --profile backup rm -sf backup-privacy-replay-db >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" --profile backup build \
  backup-privacy-replay-migrate \
  backup-privacy-artifact-plan \
  backup-privacy-replay \
  backup-privacy-artifact-replay \
  backup-restore-healthcheck
"${compose[@]}" --profile backup run --rm backup-privacy-replay-migrate
"${compose[@]}" --profile backup run --rm \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  backup-privacy-artifact-plan
"${compose[@]}" --profile backup run --rm \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  backup-privacy-replay
"${compose[@]}" --profile backup run --rm \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  backup-privacy-artifact-replay
"${compose[@]}" --profile backup run --rm \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  backup-restore-healthcheck
