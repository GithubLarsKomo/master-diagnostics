#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ASSESS="${ROOT_DIR}/infra/backup/assess-club-restore-promotion-switch.sh"
COMPOSE_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_BASE_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.club.yml}"
ENV_FILE="${RESTORE_PRIVATE_PROMOTION_EXECUTOR_ENV_FILE:-${ROOT_DIR}/.env}"

if [[ $# -ne 2 || ( "$2" != "candidate" && "$2" != "rollback" ) ]]; then
  echo "Usage: bash infra/backup/check-club-restore-promotion-switch-health.sh restore-<timestamp>-<uuid> candidate|rollback" >&2
  exit 2
fi
staging_name="$1"
target="$2"
for path in "${ASSESS}" "${COMPOSE_FILE}" "${ENV_FILE}"; do
  [[ -f "${path}" ]] || { echo "Promotion switch health dependency is missing: ${path}" >&2; exit 1; }
done

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
journal_root="${RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_HOST_DIR:-/var/lib/master-diagnostics/restore-promotion-switch-journal}"
workspace="${replay_root}/${staging_name}"
switch_intent="${workspace}/promotion/switch/promotion-switch-intent.json"
[[ -f "${switch_intent}" && ! -L "${switch_intent}" ]] || { echo "Signed switch intent is missing or unsafe." >&2; exit 1; }

candidate_set_id="$(python3 - "${switch_intent}" <<'PY'
import json,re,sys
from pathlib import Path
value=json.loads(Path(sys.argv[1]).read_text()).get('record',{}).get('candidateSetId')
if not isinstance(value,str) or not re.fullmatch(r'restore-[0-9a-f]{20}',value): raise SystemExit('Invalid candidateSetId')
print(value)
PY
)"
evidence_dir="${journal_root}/${candidate_set_id}"
journal_file="${evidence_dir}/promotion-switch-journal.json"
[[ -f "${journal_file}" && ! -L "${journal_file}" ]] || { echo "Durable switch journal is missing or unsafe." >&2; exit 1; }

assessment_raw="$(bash "${ASSESS}" "${staging_name}")"
assessment_json="$(printf '%s\n' "${assessment_raw}" | awk 'NF{line=$0} END{print line}')"
expected_status="VERIFY_CANDIDATE"
[[ "${target}" == "rollback" ]] && expected_status="VERIFY_ROLLBACK"
python3 - "${assessment_json}" "${expected_status}" <<'PY'
import json,sys
r=json.loads(sys.argv[1])
if r.get('status') != sys.argv[2]: raise SystemExit(f"Unexpected switch assessment status: {r.get('status')}")
PY

base_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
resolve_one() {
  local service="$1" ids=()
  mapfile -t ids < <("${base_compose[@]}" ps -a -q "${service}" | awk 'NF')
  [[ ${#ids[@]} -eq 1 ]] || { echo "Expected exactly one ${service} container, found ${#ids[@]}." >&2; exit 1; }
  printf '%s\n' "${ids[0]}"
}
container_state() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{if .State.Running}}running{{else}}stopped{{end}}{{end}}' "$1"
}
require_healthy() {
  local service="$1" id state
  id="$(resolve_one "${service}")"
  state="$(container_state "${id}")"
  [[ "${state}" == "healthy" ]] || { echo "${service} is not healthy: ${state}" >&2; exit 1; }
  printf '%s\n' "${id}"
}
require_running() {
  local service="$1" id running
  id="$(resolve_one "${service}")"
  running="$(docker inspect --format '{{.State.Running}}' "${id}")"
  [[ "${running}" == "true" ]] || { echo "${service} is not running." >&2; exit 1; }
  printf '%s\n' "${id}"
}

libsql_id="$(require_healthy libsql)"
app_id="$(require_healthy app)"
export_cleanup_id="$(require_running export-cleanup)"
retention_scan_id="$(require_running retention-scan)"
caddy_id="$(require_running caddy)"
if [[ -n "${RESTORE_PRIVATE_PROMOTION_EXPECTED_CADDY_CONTAINER_ID:-}" && "${caddy_id}" != "${RESTORE_PRIVATE_PROMOTION_EXPECTED_CADDY_CONTAINER_ID}" ]]; then
  echo "Caddy container identity changed during restore promotion." >&2
  exit 1
fi

mapfile -t bound < <(python3 - "${journal_file}" "${target}" <<'PY'
import json,sys
r=json.loads(open(sys.argv[1]).read())['record']
field='candidateVolumeName' if sys.argv[2]=='candidate' else 'rollbackVolumeName'
for item in r['volumes']: print(item[field])
PY
)
[[ ${#bound[@]} -eq 4 ]] || { echo "Journal volume set is invalid." >&2; exit 1; }

# Rollback volumes are retained throughout both candidate verification and rollback verification.
mapfile -t rollback_volumes < <(python3 - "${journal_file}" <<'PY'
import json,sys
for item in json.loads(open(sys.argv[1]).read())['record']['volumes']: print(item['rollbackVolumeName'])
PY
)
for volume in "${rollback_volumes[@]}"; do
  docker volume inspect "${volume}" >/dev/null
 done

checked_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
if [[ "${target}" == "candidate" ]]; then
  python3 - "${checked_at}" "${candidate_set_id}" "${bound[@]}" <<'PY'
import json,sys
roles=['LIBSQL','REPORTS','TENANT_EXPORTS','DATA_SUBJECT_DELIVERY']
print(json.dumps({
  'mode':'CLUB_RESTORE_PROMOTION_POST_SWITCH_HEALTHCHECK','status':'HEALTHY','healthcheckVersion':1,
  'checkedAt':sys.argv[1],'candidateSetId':sys.argv[2],'currentVolumeSet':'CANDIDATE',
  'libsqlHealth':'HEALTHY','appHealth':'HEALTHY','exportCleanupRunning':True,'retentionScanRunning':True,
  'caddyPreserved':True,'rollbackVolumesRetained':True,
  'candidateVolumes':[{'role':r,'volumeName':v} for r,v in zip(roles,sys.argv[3:7])]
},separators=(',',':')))
PY
else
  python3 - "${checked_at}" "${candidate_set_id}" <<'PY'
import json,sys
print(json.dumps({
  'mode':'CLUB_RESTORE_PROMOTION_ROLLBACK_HEALTHCHECK','status':'HEALTHY','healthcheckVersion':1,
  'checkedAt':sys.argv[1],'candidateSetId':sys.argv[2],'currentVolumeSet':'ROLLBACK',
  'libsqlHealth':'HEALTHY','appHealth':'HEALTHY','exportCleanupRunning':True,'retentionScanRunning':True,
  'caddyPreserved':True,'rollbackVolumesRetained':True
},separators=(',',':')))
PY
fi
