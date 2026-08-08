#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
PROMOTION_COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.restore-promotion.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/authorize-club-restore-promotion.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -f "${PROMOTION_COMPOSE_FILE}" ]]; then
  echo "Missing ${PROMOTION_COMPOSE_FILE}; promotion authorization wiring is incomplete." >&2
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
promotion_key="${RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-promotion.key}"
recovery_key="${RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-recovery-intent.key}"
source_root="${staging_root}/${staging_name}"
manifest_path="${source_root}/manifest.json"
workspace="${replay_root}/${staging_name}"
promotion_dir="${workspace}/promotion"
artifact_manifest_path="${workspace}/artifact-replay-manifest.json"
artifact_result_path="${workspace}/artifact-replay-result.json"
recovery_plan_path="${workspace}/recovery-plan.json"
recovery_execution_dir="${workspace}/recovery-execution"
recovery_intent_path="${recovery_execution_dir}/recovery-execution-pending.json"
recovery_receipt_path="${recovery_execution_dir}/recovery-execution-completed.json"
required_workspace_dirs=(libsql reports tenant-exports data-subject-delivery)

require_regular_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

require_non_symlink_dir() {
  local path="$1"
  local label="$2"
  if [[ ! -d "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

require_regular_file "${manifest_path}" "Restore staging manifest"
require_non_symlink_dir "${workspace}" "Private restore workspace"
for source_name in "${required_workspace_dirs[@]}"; do
  require_non_symlink_dir "${workspace}/${source_name}" "Private restore workspace directory ${source_name}"
done
require_regular_file "${artifact_manifest_path}" "Restore artifact replay manifest"
require_regular_file "${artifact_result_path}" "Restore artifact replay result"
require_regular_file "${promotion_key}" "Restore promotion intent key"

if [[ -e "${promotion_dir}" && ( ! -d "${promotion_dir}" || -L "${promotion_dir}" ) ]]; then
  echo "Restore promotion intent directory is unsafe: ${promotion_dir}" >&2
  exit 1
fi
mkdir -p -- "${promotion_dir}"
chmod 0700 "${promotion_dir}"

# Recovery evidence is optional. If a safe recovery key exists, expose it read-only so the CLI can
# verify a complete recovery evidence set. If no key exists, the CLI/readiness gate remains
# fail-closed when current DB or partial filesystem evidence proves recovery occurred.
recovery_run_args=()
if [[ -e "${recovery_key}" ]]; then
  require_regular_file "${recovery_key}" "Restore recovery intent key"
  recovery_run_args+=(
    -v "${recovery_key}:/run/secrets/restore-private-recovery-intent.key:ro"
    -e "RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE=/run/secrets/restore-private-recovery-intent.key"
  )
fi

# Reject unsafe recovery evidence paths before handing them to the container. Missing files are
# allowed here because partial/missing evidence is a policy decision for the read-only gate.
for evidence_path in "${recovery_plan_path}" "${recovery_intent_path}" "${recovery_receipt_path}"; do
  if [[ -e "${evidence_path}" && ( ! -f "${evidence_path}" || -L "${evidence_path}" ) ]]; then
    echo "Restore recovery evidence path is unsafe: ${evidence_path}" >&2
    exit 1
  fi
done
if [[ -e "${recovery_execution_dir}" && ( ! -d "${recovery_execution_dir}" || -L "${recovery_execution_dir}" ) ]]; then
  echo "Restore recovery execution directory is unsafe: ${recovery_execution_dir}" >&2
  exit 1
fi

export RESTORE_STAGING_NAME="${staging_name}"
compose=(
  docker compose
  --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
  -f "${PROMOTION_COMPOSE_FILE}"
)
cleanup() {
  "${compose[@]}" --profile backup rm -sf backup-privacy-replay-db >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" --profile backup build \
  backup-privacy-replay-migrate \
  backup-restore-promotion-intent
"${compose[@]}" --profile backup run --rm backup-privacy-replay-migrate
"${compose[@]}" --profile backup run --rm \
  "${recovery_run_args[@]}" \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  backup-restore-promotion-intent
