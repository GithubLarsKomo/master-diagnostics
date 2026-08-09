#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
REPORT_WRITER="${SCRIPT_DIR}/write-restore-rto-drill-report.py"
LOCK_FILE="/run/lock/master-diagnostics-restore-rto-drill.lock"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/run-club-restore-rto-drill.sh masters-backup-<timestamp>-<uuid>.mdbak" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" || -L "${ENV_FILE}" ]]; then
  echo "Missing or unsafe ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -f "${REPORT_WRITER}" || -L "${REPORT_WRITER}" ]]; then
  echo "Restore RTO drill report writer is missing or unsafe." >&2
  exit 1
fi

bundle_name="$1"
if [[ ! "${bundle_name}" =~ ^masters-backup-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdbak$ ]]; then
  echo "Backup file name is invalid." >&2
  exit 2
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another restore RTO drill is already executing." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

backup_root="${BACKUP_HOST_DIR:-/var/backups/master-diagnostics}"
replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
report_root="${RESTORE_RTO_DRILL_REPORT_HOST_DIR:-/var/lib/master-diagnostics/restore-rto-drills}"
report_key="${RESTORE_RTO_DRILL_REPORT_KEY_FILE:-/etc/master-diagnostics/restore-rto-drill-report.key}"
bundle_path="${backup_root}/${bundle_name}"

require_regular_file() {
  local path="$1" label="$2"
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}
require_regular_file "${bundle_path}" "Backup bundle"
require_regular_file "${bundle_path}.sha256" "Backup checksum sidecar"
require_regular_file "${report_key}" "Restore RTO drill report key"

for command_path in \
  "${SCRIPT_DIR}/verify-club-backup.sh" \
  "${SCRIPT_DIR}/stage-club-restore.sh" \
  "${SCRIPT_DIR}/replay-club-restore-privacy-db.sh" \
  "${SCRIPT_DIR}/authorize-club-restore-promotion.sh" \
  "${SCRIPT_DIR}/prepare-club-restore-promotion-plan.sh" \
  "${SCRIPT_DIR}/prepare-club-restore-promotion-candidates.sh" \
  "${SCRIPT_DIR}/authorize-club-restore-promotion-switch.sh" \
  "${SCRIPT_DIR}/execute-club-restore-promotion-switch.sh"; do
  require_regular_file "${command_path}" "Restore RTO drill dependency"
done

mkdir -p -- "${report_root}"
if [[ ! -d "${report_root}" || -L "${report_root}" ]]; then
  echo "Restore RTO drill report root is unsafe: ${report_root}" >&2
  exit 1
fi
chmod 0700 "${report_root}"

tmp_dir="$(mktemp -d)"
chmod 0700 "${tmp_dir}"
phases_file="${tmp_dir}/phases.json"
printf '[]\n' >"${phases_file}"
chmod 0600 "${phases_file}"

drill_id="drill-$(python3 - <<'PY'
import uuid
print(uuid.uuid4().hex)
PY
)"
started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
started_epoch="$(date +%s)"
bundle_sha256="sha256:$(sha256sum "${bundle_path}" | awk '{print $1}')"
staging_name=""
candidate_set_id=""
current_phase="VERIFY_BACKUP"
overall_status="FAILED"
report_written=false

append_phase() {
  local name="$1" status="$2" duration="$3" exit_code="$4"
  python3 - "${phases_file}" "${name}" "${status}" "${duration}" "${exit_code}" <<'PY'
import json, sys
from pathlib import Path
path=Path(sys.argv[1])
rows=json.loads(path.read_text())
rows.append({"name":sys.argv[2],"status":sys.argv[3],"durationSeconds":int(sys.argv[4]),"exitCode":int(sys.argv[5])})
path.write_text(json.dumps(rows,separators=(',',':'))+'\n')
PY
}

write_report() {
  local terminal_phase="$1"
  if [[ "${report_written}" == true ]]; then return 0; fi
  local completed_at completed_epoch duration
  completed_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  completed_epoch="$(date +%s)"
  duration=$((completed_epoch - started_epoch))
  python3 "${REPORT_WRITER}" \
    --output-dir "${report_root}" \
    --key-file "${report_key}" \
    --drill-id "${drill_id}" \
    --bundle-name "${bundle_name}" \
    --bundle-sha256 "${bundle_sha256}" \
    --staging-name "${staging_name}" \
    --candidate-set-id "${candidate_set_id}" \
    --started-at "${started_at}" \
    --completed-at "${completed_at}" \
    --duration-seconds "${duration}" \
    --status "${overall_status}" \
    --terminal-phase "${terminal_phase}" \
    --phases-file "${phases_file}"
  report_written=true
}

cleanup() {
  local code=$?
  if [[ "${report_written}" != true ]]; then
    write_report "${current_phase}" || true
  fi
  rm -rf -- "${tmp_dir}"
  exit "${code}"
}
trap cleanup EXIT

run_phase() {
  local name="$1"; shift
  current_phase="${name}"
  local phase_started phase_ended code
  phase_started="$(date +%s)"
  set +e
  "$@"
  code=$?
  set -e
  phase_ended="$(date +%s)"
  if [[ ${code} -eq 0 ]]; then
    append_phase "${name}" COMPLETED "$((phase_ended - phase_started))" 0
    return 0
  fi
  append_phase "${name}" FAILED "$((phase_ended - phase_started))" "${code}"
  return "${code}"
}

run_phase VERIFY_BACKUP bash "${SCRIPT_DIR}/verify-club-backup.sh" "${bundle_name}"

current_phase="STAGE_RESTORE"
phase_started="$(date +%s)"
set +e
bash "${SCRIPT_DIR}/stage-club-restore.sh" "${bundle_name}" >"${tmp_dir}/stage.raw"
stage_code=$?
set -e
phase_ended="$(date +%s)"
if [[ ${stage_code} -ne 0 ]]; then
  append_phase STAGE_RESTORE FAILED "$((phase_ended - phase_started))" "${stage_code}"
  exit "${stage_code}"
fi
staging_name="$(python3 - "${tmp_dir}/stage.raw" <<'PY'
import json,re,sys
from pathlib import Path
lines=[line.strip() for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
for line in reversed(lines):
    try: data=json.loads(line)
    except json.JSONDecodeError: continue
    value=data.get('stagingName')
    if data.get('ok') is True and isinstance(value,str) and re.fullmatch(r'restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',value):
        print(value)
        raise SystemExit(0)
raise SystemExit('Restore staging did not return a valid stagingName')
PY
)"
append_phase STAGE_RESTORE COMPLETED "$((phase_ended - phase_started))" 0

run_phase PRIVACY_REPLAY bash "${SCRIPT_DIR}/replay-club-restore-privacy-db.sh" "${staging_name}"
run_phase AUTHORIZE_PROMOTION bash "${SCRIPT_DIR}/authorize-club-restore-promotion.sh" "${staging_name}"
run_phase PREPARE_PROMOTION_PLAN bash "${SCRIPT_DIR}/prepare-club-restore-promotion-plan.sh" "${staging_name}"
run_phase PREPARE_CANDIDATES bash "${SCRIPT_DIR}/prepare-club-restore-promotion-candidates.sh" "${staging_name}"
run_phase AUTHORIZE_SWITCH bash "${SCRIPT_DIR}/authorize-club-restore-promotion-switch.sh" "${staging_name}"

switch_intent="${replay_root}/${staging_name}/promotion/switch/promotion-switch-intent.json"
require_regular_file "${switch_intent}" "Signed restore promotion switch intent"
candidate_set_id="$(python3 - "${switch_intent}" <<'PY'
import json,re,sys
from pathlib import Path
value=json.loads(Path(sys.argv[1]).read_text()).get('record',{}).get('candidateSetId')
if not isinstance(value,str) or not re.fullmatch(r'restore-[0-9a-f]{20}',value):
    raise SystemExit('Restore promotion switch candidateSetId is invalid')
print(value)
PY
)"

current_phase="EXECUTE_SWITCH"
phase_started="$(date +%s)"
set +e
bash "${SCRIPT_DIR}/execute-club-restore-promotion-switch.sh" "${staging_name}" >"${tmp_dir}/switch.raw"
switch_code=$?
set -e
phase_ended="$(date +%s)"
switch_status="$(python3 - "${tmp_dir}/switch.raw" <<'PY'
import json,sys
from pathlib import Path
lines=[line.strip() for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
for line in reversed(lines):
    try: data=json.loads(line)
    except json.JSONDecodeError: continue
    if data.get('mode')=='CLUB_RESTORE_PROMOTION_SWITCH_EXECUTOR' and data.get('status') in ('COMPLETED','ROLLED_BACK'):
        print(data['status'])
        raise SystemExit(0)
print('FAILED')
PY
)"
if [[ "${switch_status}" == COMPLETED && ${switch_code} -eq 0 ]]; then
  append_phase EXECUTE_SWITCH COMPLETED "$((phase_ended - phase_started))" 0
  overall_status=COMPLETED
  write_report EXECUTE_SWITCH
  exit 0
fi
if [[ "${switch_status}" == ROLLED_BACK ]]; then
  append_phase EXECUTE_SWITCH FAILED "$((phase_ended - phase_started))" "${switch_code}"
  overall_status=ROLLED_BACK
  write_report EXECUTE_SWITCH
  exit 1
fi
append_phase EXECUTE_SWITCH FAILED "$((phase_ended - phase_started))" "${switch_code}"
overall_status=FAILED
write_report EXECUTE_SWITCH
exit "${switch_code:-1}"
