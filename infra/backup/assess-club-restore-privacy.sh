#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
ASSESSMENT_COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.restore-assessment.yml"
ENV_FILE="${ROOT_DIR}/.env"
LOCK_FILE="${MASTER_DIAGNOSTICS_RESTORE_ASSESSMENT_LOCK_FILE:-/tmp/master-diagnostics-restore-assessment.lock}"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/assess-club-restore-privacy.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -r /proc/sys/kernel/random/uuid ]]; then
  echo "Linux UUID source /proc/sys/kernel/random/uuid is required." >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for serialized restore assessments." >&2
  exit 1
fi

staging_name="$1"
if [[ ! "${staging_name}" =~ ^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Restore staging name is invalid." >&2
  exit 2
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another restore privacy assessment is already running." >&2
  exit 1
fi

work_name="restore-work-$(cat /proc/sys/kernel/random/uuid)"
export RESTORE_WORK_NAME="${work_name}"
compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -f "${ASSESSMENT_COMPOSE_FILE}")
prepared=0

cleanup() {
  "${compose[@]}" --profile backup stop -t 10 backup-restore-assessment-db >/dev/null 2>&1 || true
  "${compose[@]}" --profile backup rm -f backup-restore-assessment-db >/dev/null 2>&1 || true
  if [[ "${prepared}" -eq 1 ]]; then
    "${compose[@]}" --profile backup run --rm --no-deps \
      -e RESTORE_WORK_ACTION=cleanup \
      -e "RESTORE_WORK_NAME=${work_name}" \
      backup-restore-assessment-work >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

"${compose[@]}" --profile backup build backup-restore-assessment-work backup-privacy-assess
"${compose[@]}" --profile backup run --rm --no-deps \
  -e RESTORE_WORK_ACTION=prepare \
  -e "RESTORE_STAGING_NAME=${staging_name}" \
  -e "RESTORE_WORK_NAME=${work_name}" \
  backup-restore-assessment-work
prepared=1

"${compose[@]}" --profile backup up -d --wait --wait-timeout 60 backup-restore-assessment-db

set +e
"${compose[@]}" --profile backup run --rm --no-deps \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  backup-privacy-assess
status=$?
set -e

cleanup
prepared=0
trap - EXIT INT TERM
exit "${status}"
