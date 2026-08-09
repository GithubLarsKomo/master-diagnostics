#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_BASE_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.club.yml}"
ASSESSMENT_COMPOSE_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_ASSESSMENT_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.restore-promotion-assessment.yml}"
RESOLVER="${ROOT_DIR}/infra/backup/resolve-active-club-volumes.py"
ENV_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_ENV_FILE:-${ROOT_DIR}/.env}"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/assess-club-restore-promotion-switch.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
for path in "${ENV_FILE}" "${COMPOSE_FILE}" "${ASSESSMENT_COMPOSE_FILE}" "${RESOLVER}"; do
  if [[ ! -f "${path}" ]]; then
    echo "Switch assessment dependency is missing: ${path}" >&2
    exit 1
  fi
done

staging_name="$1"
if [[ ! "${staging_name}" =~ ^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Restore staging name is invalid." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
journal_root="${RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_HOST_DIR:-/var/lib/master-diagnostics/restore-promotion-switch-journal}"
promotion_key="${RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-promotion.key}"
workspace="${replay_root}/${staging_name}"
switch_intent="${workspace}/promotion/switch/promotion-switch-intent.json"

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

require_non_symlink_dir "${workspace}" "Private restore workspace"
require_regular_file "${switch_intent}" "Signed restore promotion switch intent"
require_regular_file "${promotion_key}" "Restore promotion key"

candidate_set_id="$(python3 - "${switch_intent}" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    envelope = json.loads(path.read_text())
except json.JSONDecodeError as exc:
    raise SystemExit('Restore promotion switch intent is not valid JSON') from exc
candidate_set_id = envelope.get('record', {}).get('candidateSetId')
if not isinstance(candidate_set_id, str) or not re.fullmatch(r'restore-[0-9a-f]{20}', candidate_set_id):
    raise SystemExit('Restore promotion switch intent candidateSetId is invalid')
print(candidate_set_id)
PY
)"
evidence_dir="${journal_root}/${candidate_set_id}"
journal_file="${evidence_dir}/promotion-switch-journal.json"
require_non_symlink_dir "${evidence_dir}" "Durable restore promotion switch evidence directory"
require_regular_file "${journal_file}" "Durable restore promotion switch journal"

base_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

resolve_container_id() {
  local service="$1"
  local ids=()
  mapfile -t ids < <("${base_compose[@]}" ps -a -q "${service}" | awk 'NF')
  if [[ ${#ids[@]} -ne 1 ]]; then
    echo "Expected exactly one existing ${service} container, found ${#ids[@]}." >&2
    exit 1
  fi
  printf '%s\n' "${ids[0]}"
}

tmp_dir="$(mktemp -d)"
chmod 0700 "${tmp_dir}"
cleanup() { rm -rf -- "${tmp_dir}"; }
trap cleanup EXIT

"${base_compose[@]}" config --format json >"${tmp_dir}/compose.json"
app_container_id="$(resolve_container_id app)"
libsql_container_id="$(resolve_container_id libsql)"
docker inspect "${app_container_id}" >"${tmp_dir}/app-inspect.json"
docker inspect "${libsql_container_id}" >"${tmp_dir}/libsql-inspect.json"

resolved_volumes=()
mapfile -t resolved_volumes < <(
  python3 "${RESOLVER}" \
    --compose-json "${tmp_dir}/compose.json" \
    --app-inspect-json "${tmp_dir}/app-inspect.json" \
    --libsql-inspect-json "${tmp_dir}/libsql-inspect.json" \
    --format lines
)
if [[ ${#resolved_volumes[@]} -ne 4 ]]; then
  echo "Active application volume resolver returned an invalid result." >&2
  exit 1
fi

export RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_HOST_FILE="${switch_intent}"
export RESTORE_PRIVATE_PROMOTION_SWITCH_EVIDENCE_HOST_DIR="${evidence_dir}"
assessment_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -f "${ASSESSMENT_COMPOSE_FILE}")

if [[ "${RESTORE_PRIVATE_PROMOTION_EXECUTOR_SKIP_BUILD:-false}" != "true" ]]; then
  "${assessment_compose[@]}" --profile backup build backup-restore-promotion-switch-assess >&2
fi
"${assessment_compose[@]}" --profile backup run --rm --no-deps \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_LIBSQL_VOLUME=${resolved_volumes[0]}" \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_REPORTS_VOLUME=${resolved_volumes[1]}" \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_TENANT_EXPORTS_VOLUME=${resolved_volumes[2]}" \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_DATA_SUBJECT_DELIVERY_VOLUME=${resolved_volumes[3]}" \
  backup-restore-promotion-switch-assess
