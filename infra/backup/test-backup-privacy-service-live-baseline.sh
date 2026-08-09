#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
key="${fixture}/key"
baseline_tool="${SCRIPT_DIR}/backup-privacy-service-live-baseline.py"

# Produce authentic #231 handoff and #234 v2 plan.
bash "${SCRIPT_DIR}/test-backup-privacy-service-cutover-plan-v2.sh" >/dev/null
activation_plan="$(cat "${success}/plan-path")"
pending="$(cat "${success}/pending-path")"
handoff="$(dirname "${pending}")/activation-target-handoff.json"
cutover_plan="$(cat "${success}/cutover-v2-plan-path")"
env_file="${success}/club.env"
target_checker="${fixture}/target-config-checker.py"

cleanup() { rm -f -- "${ROOT_DIR}/.env"; }
trap cleanup EXIT
cp "${env_file}" "${ROOT_DIR}/.env"; chmod 0600 "${ROOT_DIR}/.env"

root="${fixture}/service-live-baseline"
rm -rf -- "${root}"
mkdir -p "${root}/inspect/pre" "${root}/inspect/app-drift" "${root}/inspect/caddy-drift" "${root}/inspect/volume-drift" "${root}/inspect/enabled" "${root}/evidence"
chmod 0700 "${root}" "${root}/inspect" "${root}/inspect/pre" "${root}/inspect/app-drift" "${root}/inspect/caddy-drift" "${root}/inspect/volume-drift" "${root}/inspect/enabled" "${root}/evidence"

python3 - "${root}" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])/'inspect'
project='ci-live-baseline'
ids={'app':'1'*64,'export-cleanup':'2'*64,'retention-scan':'3'*64,'libsql':'4'*64,'caddy':'5'*64,'app-drift':'6'*64,'caddy-drift':'7'*64}
images={'web':'sha256:'+'a'*64,'libsql':'sha256:'+'b'*64,'caddy':'sha256:'+'c'*64}
refs={'web':'masters/web:test','libsql':'ghcr.io/tursodatabase/libsql-server:test','caddy':'caddy:test'}
vols={'libsql':'ci_libsql','reports':'ci_reports','exports':'ci_exports','delivery':'ci_delivery'}

def mount(name,dest): return {'Type':'volume','Name':name,'Destination':dest,'RW':True}
def obj(service,cid,image,image_ref,env,mounts,healthy=False):
    state={'Status':'running'}
    if healthy: state['Health']={'Status':'healthy'}
    return [{'Id':cid,'Image':image,'Config':{'Image':image_ref,'Labels':{'com.docker.compose.project':project,'com.docker.compose.service':service},'Env':env},'State':state,'Mounts':mounts}]
def write(folder,service,cid=None,state='DISABLED',report_volume=None,caddy_id=None):
    if service=='app':
        env=[f'PRIVACY_BACKUP_STATE={state}']
        mounts=[mount(report_volume or vols['reports'],'/var/lib/masters/reports'),mount(vols['exports'],'/var/lib/masters/exports'),mount(vols['delivery'],'/var/lib/masters/data-subject-delivery-packages')]
        value=obj(service,cid or ids['app'],images['web'],refs['web'],env,mounts,True)
    elif service=='export-cleanup':
        env=[f'PRIVACY_BACKUP_STATE={state}']
        mounts=[mount(vols['exports'],'/var/lib/masters/exports'),mount(vols['delivery'],'/var/lib/masters/data-subject-delivery-packages')]
        value=obj(service,cid or ids[service],images['web'],refs['web'],env,mounts)
    elif service=='retention-scan':
        value=obj(service,cid or ids[service],images['web'],refs['web'],[f'PRIVACY_BACKUP_STATE={state}'],[])
    elif service=='libsql':
        value=obj(service,ids['libsql'],images['libsql'],refs['libsql'],[],[mount(vols['libsql'],'/var/lib/sqld')],True)
    else:
        value=obj(service,caddy_id or ids['caddy'],images['caddy'],refs['caddy'],[],[])
    (root/folder/f'{service}.json').write_text(json.dumps(value)+'\n')

for folder in ('pre','app-drift','caddy-drift','volume-drift','enabled'):
    for service in ('app','export-cleanup','retention-scan','libsql','caddy'):
        write(folder,service,state='ENABLED' if folder=='enabled' and service in ('app','export-cleanup','retention-scan') else 'DISABLED')
write('app-drift','app',cid=ids['app-drift'])
write('caddy-drift','caddy',caddy_id=ids['caddy-drift'])
write('volume-drift','app',report_volume='ci_reports_changed')
PY

common=(
  --handoff-checker "${SCRIPT_DIR}/check-backup-privacy-target-handoff.py"
  --target-config-checker "${target_checker}"
  --activation-plan "${activation_plan}"
  --pending "${pending}"
  --handoff "${handoff}"
  --key-file "${key}"
  --env-file "${env_file}"
  --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml"
  --cutover-plan "${cutover_plan}"
)
inspect_args() {
  local dir="$1"
  printf '%q ' \
    --app-inspect "${dir}/app.json" \
    --export-inspect "${dir}/export-cleanup.json" \
    --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" \
    --caddy-inspect "${dir}/caddy.json"
}

pre="${root}/inspect/pre"
python3 "${baseline_tool}" prepare "${common[@]}" \
  --app-inspect "${pre}/app.json" --export-inspect "${pre}/export-cleanup.json" --retention-inspect "${pre}/retention-scan.json" \
  --libsql-inspect "${pre}/libsql.json" --caddy-inspect "${pre}/caddy.json" --output-root "${root}/evidence" >"${root}/prepared.json"
python3 - "${root}/prepared.json" "${root}/baseline-path" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1]))
assert r['status']=='SERVICE_LIVE_BASELINE_READY'
assert r['serviceCutoverMutationAllowed'] is True
assert r['serviceCutoverExecuted'] is False
assert r['liveRuntimeAttested'] is False
assert r['activationExecuted'] is False
Path(sys.argv[2]).write_text(r['baselinePath'])
PY
baseline="$(cat "${root}/baseline-path")"
test "$(stat -c '%a' "${baseline}")" = 600
test "$(stat -c '%a' "$(dirname "${baseline}")")" = 700

python3 "${baseline_tool}" check "${common[@]}" --baseline "${baseline}" \
  --app-inspect "${pre}/app.json" --export-inspect "${pre}/export-cleanup.json" --retention-inspect "${pre}/retention-scan.json" \
  --libsql-inspect "${pre}/libsql.json" --caddy-inspect "${pre}/caddy.json" >"${root}/verified.json"
python3 - "${root}/verified.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_LIVE_BASELINE_VERIFIED'; assert r['serviceCutoverMutationAllowed'] is True; assert r['activationExecuted'] is False
PY

# Retry reuses exact baseline.
python3 "${baseline_tool}" prepare "${common[@]}" \
  --app-inspect "${pre}/app.json" --export-inspect "${pre}/export-cleanup.json" --retention-inspect "${pre}/retention-scan.json" \
  --libsql-inspect "${pre}/libsql.json" --caddy-inspect "${pre}/caddy.json" --output-root "${root}/evidence" >"${root}/retry.json"
python3 - "${root}/retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['baselineCreated'] is False and r['baselineReused'] is True
PY

# Any pre-mutation container or active-volume change invalidates the baseline.
for case in app-drift caddy-drift volume-drift; do
  dir="${root}/inspect/${case}"
  set +e
  python3 "${baseline_tool}" check "${common[@]}" --baseline "${baseline}" \
    --app-inspect "${dir}/app.json" --export-inspect "${dir}/export-cleanup.json" --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" --caddy-inspect "${dir}/caddy.json" >"${root}/${case}.json"
  code=$?
  set -e
  test "${code}" -ne 0
  grep -q 'SERVICE_LIVE_BASELINE_LIVE_DRIFT' "${root}/${case}.json"
done

# A live ENABLED process set cannot be retroactively captured as the pre-mutation baseline.
enabled="${root}/inspect/enabled"
mkdir -p "${root}/enabled-evidence"; chmod 0700 "${root}/enabled-evidence"
set +e
python3 "${baseline_tool}" prepare "${common[@]}" \
  --app-inspect "${enabled}/app.json" --export-inspect "${enabled}/export-cleanup.json" --retention-inspect "${enabled}/retention-scan.json" \
  --libsql-inspect "${enabled}/libsql.json" --caddy-inspect "${enabled}/caddy.json" --output-root "${root}/enabled-evidence" >"${root}/enabled.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_LIVE_BASELINE_MUTABLE_NOT_DISABLED' "${root}/enabled.json"

# Baseline tamper is detected.
cp "${baseline}" "${baseline}.backup"
python3 - "${baseline}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['allMutableServicesDisabled']=False; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${baseline_tool}" check "${common[@]}" --baseline "${baseline}" \
  --app-inspect "${pre}/app.json" --export-inspect "${pre}/export-cleanup.json" --retention-inspect "${pre}/retention-scan.json" \
  --libsql-inspect "${pre}/libsql.json" --caddy-inspect "${pre}/caddy.json" >"${root}/tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_LIVE_BASELINE_POLICY_INVALID\|SERVICE_LIVE_BASELINE_FINGERPRINT_MISMATCH\|SERVICE_LIVE_BASELINE_SIGNATURE_MISMATCH' "${root}/tamper.json"
mv "${baseline}.backup" "${baseline}"; chmod 0600 "${baseline}"

# Evidence is technical-only and does not leak unrelated env secrets.
! grep -F 'ci-secret-success' "${baseline}"
! grep -F 'BETTER_AUTH_SECRET' "${baseline}"

# Core remains evidence-only.
python3 - "${baseline_tool}" "${SCRIPT_DIR}/prepare-club-backup-privacy-service-live-baseline.sh" <<'PY'
from pathlib import Path
import sys
core=Path(sys.argv[1]).read_text(); host=Path(sys.argv[2]).read_text()
assert 'docker compose' not in core and 'docker inspect' not in core
assert 'docker inspect' in host and 'ps -a -q' in host
for token in (' compose up ', ' compose down ', ' compose stop ', ' compose restart ', 'docker volume', 'os.replace('):
    assert token not in host, token
PY

echo 'backup privacy service live baseline contract: ok'
