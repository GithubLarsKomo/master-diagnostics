#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_BASE_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.club.yml}"
SELECTOR_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_SELECTOR_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.restore-promotion-selector.yml}"
ASSESSMENT_COMPOSE_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_ASSESSMENT_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.restore-promotion-assessment.yml}"
ENV_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_ENV_FILE:-${ROOT_DIR}/.env}"
ASSESS="${ROOT_DIR}/infra/backup/assess-club-restore-promotion-switch.sh"
HEALTH="${ROOT_DIR}/infra/backup/check-club-restore-promotion-switch-health.sh"
PREPARE_JOURNAL="${ROOT_DIR}/infra/backup/prepare-club-restore-promotion-switch-journal.sh"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/execute-club-restore-promotion-switch.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
staging_name="$1"
if [[ ! "${staging_name}" =~ ^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Restore staging name is invalid." >&2
  exit 2
fi
for path in "${COMPOSE_FILE}" "${SELECTOR_FILE}" "${ASSESSMENT_COMPOSE_FILE}" "${ENV_FILE}" "${ASSESS}" "${HEALTH}" "${PREPARE_JOURNAL}"; do
  [[ -f "${path}" ]] || { echo "Promotion switch executor dependency is missing: ${path}" >&2; exit 1; }
done

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
journal_root="${RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_HOST_DIR:-/var/lib/master-diagnostics/restore-promotion-switch-journal}"
promotion_key="${RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-promotion.key}"
workspace="${replay_root}/${staging_name}"
switch_intent="${workspace}/promotion/switch/promotion-switch-intent.json"
[[ -d "${workspace}" && ! -L "${workspace}" ]] || { echo "Private restore workspace is missing or unsafe." >&2; exit 1; }
[[ -f "${switch_intent}" && ! -L "${switch_intent}" ]] || { echo "Signed switch intent is missing or unsafe." >&2; exit 1; }
[[ -f "${promotion_key}" && ! -L "${promotion_key}" ]] || { echo "Promotion key is missing or unsafe." >&2; exit 1; }

candidate_set_id="$(python3 - "${switch_intent}" <<'PY'
import json,re,sys
from pathlib import Path
value=json.loads(Path(sys.argv[1]).read_text()).get('record',{}).get('candidateSetId')
if not isinstance(value,str) or not re.fullmatch(r'restore-[0-9a-f]{20}',value): raise SystemExit('Invalid candidateSetId')
print(value)
PY
)"
if [[ -e "${journal_root}" && ( ! -d "${journal_root}" || -L "${journal_root}" ) ]]; then
  echo "Restore promotion journal root is unsafe." >&2; exit 1
fi
mkdir -p -- "${journal_root}"; chmod 0700 "${journal_root}"
lock_file="${journal_root}/.${candidate_set_id}.switch.lock"
touch "${lock_file}"; chmod 0600 "${lock_file}"
exec 9>"${lock_file}"
flock -n 9 || { echo "Another restore promotion switch executor is active for ${candidate_set_id}." >&2; exit 1; }

evidence_dir="${journal_root}/${candidate_set_id}"
cutover_started_file="${evidence_dir}/promotion-switch-cutover-started.json"

# Before the first mutation, always recreate/verify the durable journal from a fresh #212 candidate healthcheck.
if [[ ! -f "${cutover_started_file}" ]]; then
  bash "${PREPARE_JOURNAL}" "${staging_name}" >/dev/null
fi
[[ -d "${evidence_dir}" && ! -L "${evidence_dir}" ]] || { echo "Durable switch evidence directory is missing or unsafe." >&2; exit 1; }
journal_file="${evidence_dir}/promotion-switch-journal.json"
[[ -f "${journal_file}" && ! -L "${journal_file}" ]] || { echo "Durable switch journal is missing or unsafe." >&2; exit 1; }

export RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_HOST_FILE="${switch_intent}"
export RESTORE_PRIVATE_PROMOTION_SWITCH_EVIDENCE_HOST_DIR="${evidence_dir}"
assessment_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -f "${ASSESSMENT_COMPOSE_FILE}")
base_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
selector_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -f "${SELECTOR_FILE}")

if [[ "${RESTORE_PRIVATE_PROMOTION_EXECUTOR_SKIP_BUILD:-false}" != "true" ]]; then
  "${assessment_compose[@]}" --profile backup build \
    backup-restore-promotion-switch-assess \
    backup-restore-promotion-switch-event \
    backup-restore-promotion-switch-completion-receipt >&2
fi

caddy_ids=()
mapfile -t caddy_ids < <("${base_compose[@]}" ps -a -q caddy | awk 'NF')
[[ ${#caddy_ids[@]} -eq 1 ]] || { echo "Expected exactly one existing caddy container." >&2; exit 1; }
export RESTORE_PRIVATE_PROMOTION_EXPECTED_CADDY_CONTAINER_ID="${caddy_ids[0]}"

load_volume_set() {
  local target="$1"
  mapfile -t selected_volumes < <(python3 - "${journal_file}" "${target}" <<'PY'
import json,re,sys
r=json.loads(open(sys.argv[1]).read())['record']
field='candidateVolumeName' if sys.argv[2]=='candidate' else 'rollbackVolumeName'
for item in r['volumes']:
    value=item[field]
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',value): raise SystemExit('Unsafe volume name')
    print(value)
PY
  )
  [[ ${#selected_volumes[@]} -eq 4 ]] || { echo "Switch journal volume set is invalid." >&2; exit 1; }
  export RESTORE_PRIVATE_PROMOTION_SELECTED_LIBSQL_VOLUME="${selected_volumes[0]}"
  export RESTORE_PRIVATE_PROMOTION_SELECTED_REPORTS_VOLUME="${selected_volumes[1]}"
  export RESTORE_PRIVATE_PROMOTION_SELECTED_TENANT_EXPORTS_VOLUME="${selected_volumes[2]}"
  export RESTORE_PRIVATE_PROMOTION_SELECTED_DATA_SUBJECT_DELIVERY_VOLUME="${selected_volumes[3]}"
}

assessment_status() {
  local raw last
  raw="$(bash "${ASSESS}" "${staging_name}")"
  last="$(printf '%s\n' "${raw}" | awk 'NF{line=$0} END{print line}')"
  python3 - "${last}" <<'PY'
import json,sys
print(json.loads(sys.argv[1])['status'])
PY
}

run_event() {
  local phase="$1"
  "${assessment_compose[@]}" --profile backup run --rm --no-deps \
    -e "RESTORE_PRIVATE_PROMOTION_SWITCH_EVENT_PHASE=${phase}" \
    backup-restore-promotion-switch-event >&2
}

wait_healthy() {
  local service="$1" timeout="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_HEALTH_TIMEOUT_SECONDS:-120}" id state started now
  started="$(date +%s)"
  while true; do
    mapfile -t ids < <("${selector_compose[@]}" ps -a -q "${service}" | awk 'NF')
    if [[ ${#ids[@]} -eq 1 ]]; then
      id="${ids[0]}"
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{if .State.Running}}running{{else}}stopped{{end}}{{end}}' "${id}")"
      [[ "${state}" == "healthy" ]] && return 0
    fi
    now="$(date +%s)"
    (( now - started < timeout )) || { echo "Timed out waiting for ${service} health." >&2; return 1; }
    sleep 2
  done
}

converge_to() {
  local target="$1"
  load_volume_set "${target}"
  # Caddy is deliberately excluded. Workloads are quiesced before any data-volume selector change.
  "${base_compose[@]}" stop app export-cleanup retention-scan libsql >&2 || return 1
  "${selector_compose[@]}" up -d --no-deps --force-recreate libsql >&2 || return 1
  wait_healthy libsql || return 1
  "${selector_compose[@]}" up -d --no-deps --force-recreate app export-cleanup retention-scan >&2 || return 1
  return 0
}

begin_rollback() {
  echo "Candidate promotion did not verify; beginning journal-authorized rollback." >&2
  run_event ROLLBACK_STARTED || return 1
  converge_to rollback || return 1
}

write_candidate_health() {
  local file="$1"
  bash "${HEALTH}" "${staging_name}" candidate >"${file}"
  chmod 0600 "${file}"
}

write_receipt() {
  local health_file="$1"
  export RESTORE_PRIVATE_PROMOTION_POST_SWITCH_HEALTHCHECK_HOST_FILE="${health_file}"
  "${assessment_compose[@]}" --profile backup run --rm --no-deps \
    backup-restore-promotion-switch-completion-receipt >&2
}

for iteration in {1..20}; do
  status="$(assessment_status)"
  echo "Restore promotion switch state: ${status}" >&2
  case "${status}" in
    READY_TO_START)
      run_event CUTOVER_STARTED
      ;;
    READY_TO_SELECT_CANDIDATE)
      if ! converge_to candidate; then
        begin_rollback || true
      fi
      ;;
    RECOVER_CANDIDATE_SELECTION)
      run_event CANDIDATE_SELECTED
      ;;
    VERIFY_CANDIDATE)
      tmp_health="$(mktemp)"
      chmod 0600 "${tmp_health}"
      if write_candidate_health "${tmp_health}" && write_receipt "${tmp_health}"; then
        run_event COMPLETED
      else
        rm -f -- "${tmp_health}"
        begin_rollback || true
      fi
      rm -f -- "${tmp_health}"
      ;;
    READY_TO_SELECT_ROLLBACK)
      converge_to rollback || { echo "Rollback convergence is incomplete; rerun executor to resume." >&2; exit 1; }
      ;;
    RECOVER_ROLLBACK_SELECTION)
      run_event ROLLBACK_SELECTED
      ;;
    VERIFY_ROLLBACK)
      if bash "${HEALTH}" "${staging_name}" rollback >/dev/null; then
        run_event ROLLBACK_VERIFIED
      else
        echo "Rollback volumes are selected but rollback health verification failed." >&2
        exit 1
      fi
      ;;
    COMPLETED)
      echo "Restore promotion switch completed with signed health-bound receipt." >&2
      exit 0
      ;;
    ROLLED_BACK)
      echo "Restore promotion failed and was safely rolled back." >&2
      exit 3
      ;;
    BLOCKED)
      echo "Restore promotion switch is blocked by authenticated evidence/current-volume state." >&2
      exit 1
      ;;
    *)
      echo "Unexpected restore promotion switch state: ${status}" >&2
      exit 1
      ;;
  esac
done

echo "Restore promotion switch exceeded bounded recovery iterations." >&2
exit 1
