#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
key="${fixture}/key"
compose_file="${ROOT_DIR}/infra/docker-compose.club.yml"
activation_plan_checker="${SCRIPT_DIR}/check-backup-privacy-activation-plan.py"
execution_evidence_checker="${SCRIPT_DIR}/backup-privacy-activation-execution.py"
completion_checker="${SCRIPT_DIR}/check-backup-privacy-activation-completion.py"
cutover_plan_checker="${SCRIPT_DIR}/check-backup-privacy-service-cutover-plan.py"
writer="${SCRIPT_DIR}/write-backup-privacy-service-live-baseline.py"
checker="${SCRIPT_DIR}/check-backup-privacy-service-live-baseline.py"
volume_resolver="${SCRIPT_DIR}/resolve-active-club-volumes.py"
containers=()
volumes=()

cleanup() {
  if ((${#containers[@]})); then docker rm -f "${containers[@]}" >/dev/null 2>&1 || true; fi
  if ((${#volumes[@]})); then docker volume rm -f "${volumes[@]}" >/dev/null 2>&1 || true; fi
  rm -f -- "${ROOT_DIR}/.env"
}
trap cleanup EXIT

# Reuse the complete signed chain through #227.
bash "${SCRIPT_DIR}/test-backup-privacy-service-cutover-plan.sh" >/dev/null
activation_plan="$(cat "${success}/plan-path")"
pending="$(cat "${success}/pending-path")"
completion="$(dirname "${pending}")/activation-execution-completed.json"
env_file="${success}/club.env"
cutover_plan="$(cat "${success}/cutover-plan-path")"
cp "${env_file}" "${ROOT_DIR}/.env"
chmod 0600 "${ROOT_DIR}/.env"

rendered="${success}/live-baseline-rendered-compose.json"
docker compose --env-file "${env_file}" -f "${compose_file}" config --format json >"${rendered}"
project="$(python3 - "${rendered}" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['name'])
PY
)"

volume_name() {
  python3 - "${rendered}" "$1" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); logical=sys.argv[2]
defn=r['volumes'][logical]
print(defn.get('name') or f"{r['name']}_{logical}")
PY
}
libsql_volume="$(volume_name libsql-data)"
report_volume="$(volume_name report-data)"
export_volume="$(volume_name export-data)"
delivery_volume="$(volume_name data-subject-delivery-data)"
caddy_data_volume="$(volume_name caddy-data)"
caddy_config_volume="$(volume_name caddy-config)"
volumes=("${libsql_volume}" "${report_volume}" "${export_volume}" "${delivery_volume}" "${caddy_data_volume}" "${caddy_config_volume}")
for volume in "${volumes[@]}"; do docker volume create "${volume}" >/dev/null; done

docker pull alpine:3.20 >/dev/null
label_args=(--label "com.docker.compose.project=${project}" --label 'com.docker.compose.oneoff=False')
common_privacy=(
  --env PRIVACY_BACKUP_STATE=DISABLED
  --env PRIVACY_NOTIFICATIONS_STATE=DISABLED
  --env BETTER_AUTH_SECRET=baseline-live-secret-must-not-be-recorded
)

app_name="md-live-baseline-app-${GITHUB_RUN_ID:-$$}"
app_id="$(docker run -d --name "${app_name}" "${label_args[@]}" --label com.docker.compose.service=app \
  "${common_privacy[@]}" \
  --health-cmd='exit 0' --health-interval=1s --health-timeout=1s --health-retries=10 \
  -v "${report_volume}:/var/lib/masters/reports" \
  -v "${export_volume}:/var/lib/masters/exports" \
  -v "${delivery_volume}:/var/lib/masters/data-subject-delivery-packages" \
  alpine:3.20 sh -c 'while true; do sleep 3600; done')"
containers+=("${app_id}")

libsql_name="md-live-baseline-libsql-${GITHUB_RUN_ID:-$$}"
libsql_id="$(docker run -d --name "${libsql_name}" "${label_args[@]}" --label com.docker.compose.service=libsql \
  --health-cmd='exit 0' --health-interval=1s --health-timeout=1s --health-retries=10 \
  -v "${libsql_volume}:/var/lib/sqld" \
  alpine:3.20 sh -c 'while true; do sleep 3600; done')"
containers+=("${libsql_id}")

export_name="md-live-baseline-export-${GITHUB_RUN_ID:-$$}"
export_id="$(docker run -d --name "${export_name}" "${label_args[@]}" --label com.docker.compose.service=export-cleanup \
  "${common_privacy[@]}" \
  -v "${export_volume}:/var/lib/masters/exports" \
  -v "${delivery_volume}:/var/lib/masters/data-subject-delivery-packages" \
  alpine:3.20 sh -c 'while true; do sleep 3600; done')"
containers+=("${export_id}")

retention_name="md-live-baseline-retention-${GITHUB_RUN_ID:-$$}"
retention_id="$(docker run -d --name "${retention_name}" "${label_args[@]}" --label com.docker.compose.service=retention-scan \
  "${common_privacy[@]}" \
  alpine:3.20 sh -c 'while true; do sleep 3600; done')"
containers+=("${retention_id}")

caddy_name="md-live-baseline-caddy-${GITHUB_RUN_ID:-$$}"
caddy_id="$(docker run -d --name "${caddy_name}" "${label_args[@]}" --label com.docker.compose.service=caddy \
  -v "${caddy_data_volume}:/data" -v "${caddy_config_volume}:/config" \
  alpine:3.20 sh -c 'while true; do sleep 3600; done')"
containers+=("${caddy_id}")

wait_healthy() {
  local id="$1"
  for _ in $(seq 1 30); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "${id}")" == healthy ]]; then return 0; fi
    sleep 1
  done
  docker inspect "${id}"
  return 1
}
wait_healthy "${app_id}"
wait_healthy "${libsql_id}"

chain_args=(
  --cutover-plan-checker "${cutover_plan_checker}"
  --completion-checker "${completion_checker}"
  --activation-plan-checker "${activation_plan_checker}"
  --execution-evidence-checker "${execution_evidence_checker}"
  --activation-plan "${activation_plan}"
  --pending "${pending}"
  --completion "${completion}"
  --key-file "${key}"
  --env-file "${env_file}"
  --compose-file "${compose_file}"
  --cutover-plan "${cutover_plan}"
  --volume-resolver "${volume_resolver}"
)
baseline_root="${fixture}/service-live-baselines"
mkdir -p "${baseline_root}"; chmod 0700 "${baseline_root}"

python3 "${writer}" "${chain_args[@]}" --output-root "${baseline_root}" \
  --captured-at 2026-08-10T00:20:00.000Z >"${success}/live-baseline-write.json"
python3 - "${success}/live-baseline-write.json" "${success}/live-baseline-path" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_LIVE_BASELINE_RECORDED'; assert r['baselineCreated'] is True
assert r['serviceCutoverExecutionAllowed'] is False and r['serviceCutoverExecuted'] is False
Path(sys.argv[2]).write_text(r['baselinePath'])
PY
baseline="$(cat "${success}/live-baseline-path")"
test "$(stat -c '%a' "${baseline}")" = 600
test "$(stat -c '%a' "${baseline_root}")" = 700
! grep -F 'baseline-live-secret-must-not-be-recorded' "${baseline}"

python3 "${checker}" "${chain_args[@]}" --baseline "${baseline}" >"${success}/live-baseline-check.json"
python3 - "${success}/live-baseline-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_LIVE_BASELINE_VERIFIED'; assert r['serviceCutoverExecutionAllowed'] is True; assert r['serviceCutoverExecuted'] is False
PY

# Same live state reuses the deterministic baseline even with a later requested observation time.
python3 "${writer}" "${chain_args[@]}" --output-root "${baseline_root}" \
  --captured-at 2026-08-10T00:21:00.000Z >"${success}/live-baseline-retry.json"
python3 - "${success}/live-baseline-retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_LIVE_BASELINE_RECORDED'; assert r['baselineCreated'] is False and r['baselineReused'] is True
PY

# A duplicate Compose service identity blocks re-attestation before any mutation.
duplicate_name="md-live-baseline-duplicate-app-${GITHUB_RUN_ID:-$$}"
duplicate_id="$(docker run -d --name "${duplicate_name}" "${label_args[@]}" --label com.docker.compose.service=app \
  "${common_privacy[@]}" alpine:3.20 sh -c 'while true; do sleep 3600; done')"
containers+=("${duplicate_id}")
set +e
python3 "${checker}" "${chain_args[@]}" --baseline "${baseline}" >"${success}/live-baseline-duplicate.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'SERVICE_LIVE_BASELINE_CONTAINER_CARDINALITY' "${success}/live-baseline-duplicate.json"
docker rm -f "${duplicate_id}" >/dev/null
containers=("${app_id}" "${libsql_id}" "${export_id}" "${retention_id}" "${caddy_id}")

# Baseline fingerprint/HMAC tampering blocks. Keep canonical filename in a separate private directory.
tamper_dir="${fixture}/tampered-live-baseline"; mkdir -p "${tamper_dir}"; chmod 0700 "${tamper_dir}"
tampered="${tamper_dir}/$(basename "${baseline}")"
cp "${baseline}" "${tampered}"; chmod 0600 "${tampered}"
python3 - "${tampered}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['containers'][0]['imageReference']='tampered/image:latest'; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${checker}" "${chain_args[@]}" --baseline "${tampered}" >"${success}/live-baseline-tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_LIVE_BASELINE_.*MISMATCH\|SERVICE_LIVE_BASELINE_DRIFT' "${success}/live-baseline-tamper.json"

# Restarting the same container keeps its ID but changes StartedAt/RestartCount; signed baseline must go stale.
docker restart "${retention_id}" >/dev/null
set +e
python3 "${checker}" "${chain_args[@]}" --baseline "${baseline}" >"${success}/live-baseline-restart-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'SERVICE_LIVE_BASELINE_DRIFT' "${success}/live-baseline-restart-drift.json"

# Collector/verifier implementation itself is Docker read-only.
python3 - "${SCRIPT_DIR}/backup_privacy_service_live_baseline_common.py" "${writer}" "${checker}" <<'PY'
from pathlib import Path
import sys
text='\n'.join(Path(p).read_text() for p in sys.argv[1:])
for required in ('"ps"','"inspect"','"config", "--format", "json"','RestartCount','StartedAt','PRIVACY_BACKUP_STATE'):
    assert required in text, required
for forbidden in ('"run"','"create"','"start"','"stop"','"restart"','"rm"','"up"','"down"','docker volume','os.replace('):
    assert forbidden not in text, forbidden
PY

echo 'backup privacy service live baseline contract: ok'
