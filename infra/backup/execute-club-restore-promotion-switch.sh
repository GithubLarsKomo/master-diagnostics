#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
SELECTOR_COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.restore-promotion-selector.yml"
ASSESSMENT_COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.restore-promotion-assessment.yml"
ASSESS_SCRIPT="${ROOT_DIR}/infra/backup/assess-club-restore-promotion-switch.sh"
PREPARE_JOURNAL_SCRIPT="${ROOT_DIR}/infra/backup/prepare-club-restore-promotion-switch-journal.sh"
APPLY_SELECTOR_SCRIPT="${ROOT_DIR}/infra/backup/apply-club-restore-promotion-selector.sh"
HEALTHCHECK_BUILDER="${ROOT_DIR}/infra/backup/build-restore-promotion-post-switch-healthcheck.py"
RESOLVER="${ROOT_DIR}/infra/backup/resolve-active-club-volumes.py"
ENV_FILE="${ROOT_DIR}/.env"
LOCK_FILE="/run/lock/master-diagnostics-restore-promotion-switch.lock"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/execute-club-restore-promotion-switch.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
for path in \
  "${ENV_FILE}" "${COMPOSE_FILE}" "${SELECTOR_COMPOSE_FILE}" "${ASSESSMENT_COMPOSE_FILE}" \
  "${ASSESS_SCRIPT}" "${PREPARE_JOURNAL_SCRIPT}" "${APPLY_SELECTOR_SCRIPT}" \
  "${HEALTHCHECK_BUILDER}" "${RESOLVER}"; do
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "Promotion executor dependency is missing or unsafe: ${path}" >&2
    exit 1
  fi
done

staging_name="$1"
if [[ ! "${staging_name}" =~ ^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Restore staging name is invalid." >&2
  exit 2
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another restore promotion switch is already executing." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

staging_root="${RESTORE_STAGING_HOST_DIR:-/var/lib/master-diagnostics/restore-staging}"
replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
journal_root="${RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_HOST_DIR:-/var/lib/master-diagnostics/restore-promotion-switch-journal}"
promotion_key="${RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-promotion.key}"
backup_key="${BACKUP_KEY_FILE:-/etc/master-diagnostics/backup.key}"
workspace="${replay_root}/${staging_name}"
switch_intent="${workspace}/promotion/switch/promotion-switch-intent.json"
source_provenance="${staging_root}/${staging_name}/restore-source-provenance.json"

require_regular_file() {
  local path="$1" label="$2"
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}
require_non_symlink_dir() {
  local path="$1" label="$2"
  if [[ ! -d "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

require_non_symlink_dir "${workspace}" "Private restore workspace"
require_regular_file "${switch_intent}" "Signed restore promotion switch intent"
require_regular_file "${promotion_key}" "Restore promotion key"
require_regular_file "${backup_key}" "Backup key"
require_regular_file "${source_provenance}" "Signed restore source provenance"

candidate_set_id="$(python3 - "${switch_intent}" <<'PY'
import json, re, sys
from pathlib import Path
raw=json.loads(Path(sys.argv[1]).read_text())
value=raw.get('record',{}).get('candidateSetId')
if not isinstance(value,str) or not re.fullmatch(r'restore-[0-9a-f]{20}',value):
    raise SystemExit('Restore promotion switch intent candidateSetId is invalid')
print(value)
PY
)"
evidence_dir="${journal_root}/${candidate_set_id}"
journal_file="${evidence_dir}/promotion-switch-journal.json"
cutover_started_file="${evidence_dir}/promotion-switch-cutover-started.json"

if [[ ! -e "${cutover_started_file}" ]]; then
  bash "${PREPARE_JOURNAL_SCRIPT}" "${staging_name}" >/dev/null
fi
require_non_symlink_dir "${evidence_dir}" "Durable restore promotion switch evidence directory"
require_regular_file "${journal_file}" "Durable restore promotion switch journal"

volume_lines=()
mapfile -t volume_lines < <(python3 - "${journal_file}" <<'PY'
import json,re,sys
from pathlib import Path
raw=json.loads(Path(sys.argv[1]).read_text())
record=raw.get('record',{})
roles=('LIBSQL','REPORTS','TENANT_EXPORTS','DATA_SUBJECT_DELIVERY')
volumes=record.get('volumes')
if not isinstance(volumes,list) or len(volumes)!=4:
    raise SystemExit('Switch journal volume set is invalid')
for index,role in enumerate(roles):
    item=volumes[index]
    if not isinstance(item,dict) or item.get('role')!=role:
        raise SystemExit('Switch journal volume order is invalid')
    for key in ('candidateVolumeName','rollbackVolumeName'):
        value=item.get(key)
        if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',value):
            raise SystemExit(f'Switch journal {key} is unsafe')
for item in volumes: print(item['candidateVolumeName'])
for item in volumes: print(item['rollbackVolumeName'])
PY
)
if [[ ${#volume_lines[@]} -ne 8 ]]; then
  echo "Switch journal did not yield exactly eight bound volume names." >&2
  exit 1
fi
candidate_volumes=("${volume_lines[@]:0:4}")
rollback_volumes=("${volume_lines[@]:4:4}")

export RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_HOST_FILE="${switch_intent}"
export RESTORE_PRIVATE_PROMOTION_SWITCH_EVIDENCE_HOST_DIR="${evidence_dir}"
export RESTORE_SOURCE_PROVENANCE_HOST_FILE="${source_provenance}"
export BACKUP_KEY_FILE="${backup_key}"
assessment_compose=(
  docker compose --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
  -f "${ASSESSMENT_COMPOSE_FILE}"
)
base_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

"${assessment_compose[@]}" --profile backup build \
  backup-restore-promotion-switch-event \
  backup-restore-promotion-switch-completion-receipt >&2

tmp_dir="$(mktemp -d)"
chmod 0700 "${tmp_dir}"
cleanup() { rm -rf -- "${tmp_dir}"; }
trap cleanup EXIT

assessment_status() {
  local raw="${tmp_dir}/assessment.raw"
  bash "${ASSESS_SCRIPT}" "${staging_name}" >"${raw}"
  python3 - "${raw}" <<'PY'
import json,sys
from pathlib import Path
lines=[line.strip() for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
for line in reversed(lines):
    try: obj=json.loads(line)
    except json.JSONDecodeError: continue
    if obj.get('mode')=='ISOLATED_RESTORE_PROMOTION_SWITCH_EXECUTION_ASSESSMENT':
        print(obj.get('status',''))
        raise SystemExit(0)
raise SystemExit('Switch assessment did not produce a valid result')
PY
}

persist_event() {
  local phase="$1"
  "${assessment_compose[@]}" --profile backup run --rm --no-deps \
    -e "RESTORE_PRIVATE_PROMOTION_SWITCH_EVENT_PHASE=${phase}" \
    backup-restore-promotion-switch-event >/dev/null
}

apply_selector() {
  local target="$1"
  local selected=()
  case "${target}" in
    CANDIDATE) selected=("${candidate_volumes[@]}") ;;
    ROLLBACK) selected=("${rollback_volumes[@]}") ;;
    *) echo "Unknown selector target: ${target}" >&2; return 2 ;;
  esac
  export RESTORE_PRIVATE_PROMOTION_SELECTED_LIBSQL_VOLUME="${selected[0]}"
  export RESTORE_PRIVATE_PROMOTION_SELECTED_REPORTS_VOLUME="${selected[1]}"
  export RESTORE_PRIVATE_PROMOTION_SELECTED_TENANT_EXPORTS_VOLUME="${selected[2]}"
  export RESTORE_PRIVATE_PROMOTION_SELECTED_DATA_SUBJECT_DELIVERY_VOLUME="${selected[3]}"
  export RESTORE_PRIVATE_PROMOTION_BASE_COMPOSE_FILE="${COMPOSE_FILE}"
  export RESTORE_PRIVATE_PROMOTION_SELECTOR_COMPOSE_FILE="${SELECTOR_COMPOSE_FILE}"
  export RESTORE_PRIVATE_PROMOTION_ENV_FILE="${ENV_FILE}"
  unset RESTORE_PRIVATE_PROMOTION_COMPOSE_PROJECT_NAME || true
  bash "${APPLY_SELECTOR_SCRIPT}"
}

resolve_container_id() {
  local service="$1" ids=()
  mapfile -t ids < <("${base_compose[@]}" ps -q "${service}" | awk 'NF')
  if [[ ${#ids[@]} -ne 1 ]]; then
    echo "Expected exactly one running ${service} container, found ${#ids[@]}." >&2
    return 1
  fi
  printf '%s\n' "${ids[0]}"
}

resolve_current_volumes() {
  "${base_compose[@]}" config --format json >"${tmp_dir}/compose.json"
  local app_id libsql_id
  app_id="$(resolve_container_id app)" || return 1
  libsql_id="$(resolve_container_id libsql)" || return 1
  docker inspect "${app_id}" >"${tmp_dir}/app-inspect.json"
  docker inspect "${libsql_id}" >"${tmp_dir}/libsql-inspect.json"
  python3 "${RESOLVER}" \
    --compose-json "${tmp_dir}/compose.json" \
    --app-inspect-json "${tmp_dir}/app-inspect.json" \
    --libsql-inspect-json "${tmp_dir}/libsql-inspect.json" \
    --allow-explicit-volume-name-drift \
    --format lines >"${tmp_dir}/current-volumes.txt"
}

build_candidate_healthcheck() {
  resolve_current_volumes || return 1
  local service id
  for service in app libsql export-cleanup retention-scan caddy; do
    id="$(resolve_container_id "${service}")" || return 1
    docker inspect "${id}" >"${tmp_dir}/${service}-inspect.json"
  done
  docker volume inspect "${rollback_volumes[@]}" >"${tmp_dir}/rollback-volumes.json" || return 1
  python3 "${HEALTHCHECK_BUILDER}" \
    --journal "${journal_file}" \
    --current-volumes "${tmp_dir}/current-volumes.txt" \
    --rollback-volume-inspect "${tmp_dir}/rollback-volumes.json" \
    --app-inspect "${tmp_dir}/app-inspect.json" \
    --libsql-inspect "${tmp_dir}/libsql-inspect.json" \
    --export-cleanup-inspect "${tmp_dir}/export-cleanup-inspect.json" \
    --retention-scan-inspect "${tmp_dir}/retention-scan-inspect.json" \
    --caddy-inspect "${tmp_dir}/caddy-inspect.json" \
    >"${tmp_dir}/post-switch-healthcheck.json"
}

verify_rollback_health() {
  resolve_current_volumes || return 1
  python3 - "${tmp_dir}/current-volumes.txt" "${rollback_volumes[@]}" <<'PY'
import sys
from pathlib import Path
observed=[line.strip() for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
expected=sys.argv[2:]
if observed != expected:
    raise SystemExit('Current volume set is not the journal-bound rollback set')
PY
  local service id state
  for service in libsql app; do
    id="$(resolve_container_id "${service}")" || return 1
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${id}")"
    [[ "${state}" == healthy ]] || { echo "${service} is not healthy after rollback." >&2; return 1; }
  done
  for service in export-cleanup retention-scan caddy; do
    id="$(resolve_container_id "${service}")" || return 1
    state="$(docker inspect --format '{{.State.Running}}' "${id}")"
    [[ "${state}" == true ]] || { echo "${service} is not running after rollback." >&2; return 1; }
  done
}

create_completion_receipt() {
  "${assessment_compose[@]}" --profile backup run --rm --no-deps \
    -v "${tmp_dir}/post-switch-healthcheck.json:/post-switch-healthcheck.json:ro" \
    backup-restore-promotion-switch-completion-receipt >/dev/null
}

for _iteration in $(seq 1 16); do
  status="$(assessment_status)"
  case "${status}" in
    READY_TO_START)
      persist_event CUTOVER_STARTED
      ;;
    READY_TO_SELECT_CANDIDATE)
      set +e
      apply_selector CANDIDATE
      selector_code=$?
      set -e
      if [[ ${selector_code} -ne 0 ]]; then
        persist_event ROLLBACK_STARTED
      fi
      ;;
    RECOVER_CANDIDATE_SELECTION)
      persist_event CANDIDATE_SELECTED
      ;;
    VERIFY_CANDIDATE)
      set +e
      build_candidate_healthcheck
      health_code=$?
      if [[ ${health_code} -eq 0 ]]; then
        create_completion_receipt
        receipt_code=$?
      else
        receipt_code=1
      fi
      set -e
      if [[ ${health_code} -eq 0 && ${receipt_code} -eq 0 ]]; then
        persist_event COMPLETED
      else
        persist_event ROLLBACK_STARTED
      fi
      ;;
    READY_TO_SELECT_ROLLBACK)
      if ! apply_selector ROLLBACK; then
        echo "Rollback selector could not converge to the bound rollback set." >&2
        exit 1
      fi
      ;;
    RECOVER_ROLLBACK_SELECTION)
      persist_event ROLLBACK_SELECTED
      ;;
    VERIFY_ROLLBACK)
      if ! verify_rollback_health; then
        echo "Rollback selection is active but rollback health verification failed." >&2
        exit 1
      fi
      persist_event ROLLBACK_VERIFIED
      ;;
    COMPLETED)
      printf '{"mode":"CLUB_RESTORE_PROMOTION_SWITCH_EXECUTOR","status":"COMPLETED","candidateSetId":"%s","promotionExecuted":true}\n' "${candidate_set_id}"
      exit 0
      ;;
    ROLLED_BACK)
      printf '{"mode":"CLUB_RESTORE_PROMOTION_SWITCH_EXECUTOR","status":"ROLLED_BACK","candidateSetId":"%s","promotionExecuted":false}\n' "${candidate_set_id}"
      exit 1
      ;;
    BLOCKED|"")
      echo "Restore promotion switch assessment is blocked or invalid." >&2
      exit 1
      ;;
    *)
      echo "Unsupported restore promotion switch assessment state: ${status}" >&2
      exit 1
      ;;
  esac
done

echo "Restore promotion switch did not reach a terminal state within the bounded retry loop." >&2
exit 1
