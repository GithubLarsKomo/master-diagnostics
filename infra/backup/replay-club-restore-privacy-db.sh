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
source_dir="${staging_root}/${staging_name}/libsql"
manifest_path="${staging_root}/${staging_name}/manifest.json"
workspace="${replay_root}/${staging_name}"
workspace_db="${workspace}/libsql"

if [[ ! -d "${source_dir}" || ! -f "${manifest_path}" ]]; then
  echo "Restore staging is incomplete: ${staging_name}" >&2
  exit 1
fi

mkdir -p "${replay_root}"
chmod 0700 "${replay_root}"
if [[ ! -d "${workspace_db}" ]]; then
  if [[ -e "${workspace}" ]]; then
    echo "Restore privacy replay workspace exists but is incomplete: ${workspace}" >&2
    exit 1
  fi
  tmp_workspace="${replay_root}/.${staging_name}.$$.tmp"
  trap 'rm -rf -- "${tmp_workspace:-}"' EXIT
  mkdir -m 0700 "${tmp_workspace}"
  cp -a -- "${source_dir}" "${tmp_workspace}/libsql"
  mv -- "${tmp_workspace}" "${workspace}"
  trap - EXIT
fi

export RESTORE_STAGING_NAME="${staging_name}"
compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
cleanup() {
  "${compose[@]}" --profile backup rm -sf backup-privacy-replay-db >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" --profile backup build backup-privacy-replay-migrate backup-privacy-replay
"${compose[@]}" --profile backup run --rm backup-privacy-replay-migrate
"${compose[@]}" --profile backup run --rm \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  backup-privacy-replay
