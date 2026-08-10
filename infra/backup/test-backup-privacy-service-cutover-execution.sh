#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
activation_fixture=/tmp/backup-privacy-activation-executor/success
baseline_fixture=/tmp/backup-privacy-service-live-baseline-v2-fixture
baseline_root=/tmp/backup-privacy-service-live-baseline-v2
key=/tmp/backup-privacy-activation-executor/key
tool="${SCRIPT_DIR}/backup-privacy-service-cutover-execution.py"

# Build authentic target-handoff -> gated plan v2 -> independently verified baseline v2.
bash "${SCRIPT_DIR}/test-backup-privacy-service-live-baseline.sh" >/dev/null
cutover_plan="$(cat "${activation_fixture}/cutover-v2-plan-path")"
baseline="$(cat "${baseline_fixture}/baseline-path.txt")"
baseline_verification="${baseline_fixture}/baseline-verification-private.json"
cp "${baseline_fixture}/baseline-check.json" "${baseline_verification}"
chmod 0600 "${baseline_verification}"

test -f "${cutover_plan}"
test -f "${baseline}"
test -f "${baseline_verification}"

root=/tmp/backup-privacy-service-cutover-execution-v2
rm -rf -- "${root}"
mkdir -p "${root}/inspect/pre" "${root}/inspect/target" "${root}/inspect/partial" "${root}/inspect/rollback" \
  "${root}/inspect/caddy-drift" "${root}/inspect/volume-drift" "${root}/success" "${root}/rollback" "${root}/blocked"
chmod -R 0700 "${root}"

# Reconstruct Docker-inspect-shaped snapshots from the signed v2 baseline. No secret
# values outside the bounded privacy subset are introduced into the execution fixture.
python3 - "${baseline}" "${root}/inspect" <<'PY'
import json,sys
from copy import deepcopy
from pathlib import Path

baseline=Path(sys.argv[1]); out=Path(sys.argv[2])
record=json.loads(baseline.read_text())['record']
containers={item['service']:item for item in record['containers']}
project=record['composeProjectName']
data=record['dataVolumes']; caddy_vols=record['caddyVolumes']
services=('app','export-cleanup','retention-scan','libsql','caddy')

def mount(name,dest):
    return {'Type':'volume','Name':name,'Destination':dest,'RW':True}

def base_inspect(service):
    item=containers[service]
    env=[]
    for key,value in (item.get('privacyEnvironment') or {}).items(): env.append(f'{key}={value}')
    mounts=[]
    if service=='app':
        mounts=[mount(data['reports'],'/var/lib/masters/reports'),mount(data['tenantExports'],'/var/lib/masters/exports'),mount(data['dataSubjectDelivery'],'/var/lib/masters/data-subject-delivery-packages')]
    elif service=='export-cleanup':
        mounts=[mount(data['tenantExports'],'/var/lib/masters/exports'),mount(data['dataSubjectDelivery'],'/var/lib/masters/data-subject-delivery-packages')]
    elif service=='libsql': mounts=[mount(data['libsql'],'/var/lib/sqld')]
    elif service=='caddy': mounts=[mount(caddy_vols['data'],'/data'),mount(caddy_vols['config'],'/config')]
    state={'Status':'running','Running':True}
    if item.get('healthStatus') is not None: state['Health']={'Status':item['healthStatus']}
    return [{
        'Id':item['containerId'],'Image':item['imageId'],'Config':{
            'Image':item['imageReference'],'Labels':{'com.docker.compose.project':project,'com.docker.compose.service':service},'Env':env,
        },'State':state,'Mounts':mounts,
    }]

base={service:base_inspect(service) for service in services}

def write(folder, values):
    target=out/folder; target.mkdir(exist_ok=True)
    for service,value in values.items(): (target/f'{service}.json').write_text(json.dumps(value)+'\n')

write('pre',base)

target_env=[
    'PRIVACY_BACKUP_STATE=ENABLED',
    'PRIVACY_BACKUP_POLICY_VERSION=1.0.0',
    'PRIVACY_BACKUP_ENCRYPTED_AT_REST=true',
    'PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true',
    'PRIVACY_BACKUP_RESTORE_RECONCILIATION=true',
]
new_ids={'app':'8'*64,'export-cleanup':'9'*64,'retention-scan':'a'*64}
rollback_ids={'app':'b'*64,'export-cleanup':'c'*64,'retention-scan':'d'*64}

target=deepcopy(base)
for service,new_id in new_ids.items():
    target[service][0]['Id']=new_id
    target[service][0]['Config']['Env']=target_env
write('target',target)

partial=deepcopy(base)
partial['app'][0]['Id']=new_ids['app']
partial['app'][0]['Config']['Env']=target_env
write('partial',partial)

rollback=deepcopy(base)
for service,new_id in rollback_ids.items():
    rollback[service][0]['Id']=new_id
    rollback[service][0]['Config']['Env']=['PRIVACY_BACKUP_STATE=DISABLED']
write('rollback',rollback)

caddy_drift=deepcopy(base); caddy_drift['caddy'][0]['Id']='e'*64; write('caddy-drift',caddy_drift)
volume_drift=deepcopy(base)
for m in volume_drift['app'][0]['Mounts']:
    if m['Destination']=='/var/lib/masters/reports': m['Name']='unexpected-report-volume'
write('volume-drift',volume_drift)
PY

common_args() {
  local dir="$1"
  printf '%s\n' \
    --cutover-plan "${cutover_plan}" \
    --baseline "${baseline}" \
    --baseline-verification "${baseline_verification}" \
    --key-file "${key}" \
    --app-inspect "${dir}/app.json" \
    --export-inspect "${dir}/export-cleanup.json" \
    --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" \
    --caddy-inspect "${dir}/caddy.json"
}

run_prepare() {
  local execution_root="$1" output="$2"
  mapfile -t args < <(common_args "${root}/inspect/pre")
  python3 "${tool}" prepare "${args[@]}" --execution-root "${execution_root}" --recorded-at 2026-08-10T01:00:00.000Z >"${output}"
}

run_assess() {
  local journal="$1" dir="$2" output="$3"
  mapfile -t args < <(common_args "${dir}")
  python3 "${tool}" assess "${args[@]}" --journal "${journal}" >"${output}"
}

run_event() {
  local journal="$1" dir="$2" phase="$3" output="$4" attestation="${5:-}"
  mapfile -t args < <(common_args "${dir}")
  local extra=()
  if [[ -n "${attestation}" ]]; then extra+=(--attestation "${attestation}"); fi
  python3 "${tool}" event "${args[@]}" --journal "${journal}" --phase "${phase}" \
    --recorded-at 2026-08-10T01:01:00.000Z "${extra[@]}" >"${output}"
}

status_is() {
  python3 - "$1" "$2" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']==sys.argv[2], r
PY
}

# A stale/forged verifier result cannot authorize journal creation.
cp "${baseline_verification}" "${root}/blocked/tampered-verification.json"
chmod 0600 "${root}/blocked/tampered-verification.json"
python3 - "${root}/blocked/tampered-verification.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['serviceCutoverExecutionAllowed']=False; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
mapfile -t blocked_args < <(common_args "${root}/inspect/pre")
python3 "${tool}" prepare "${blocked_args[@]/${baseline_verification}/${root}/blocked/tampered-verification.json}" \
  --execution-root "${root}/blocked" >"${root}/blocked/result.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'SERVICE_LIVE_BASELINE_VERIFICATION_MISMATCH' "${root}/blocked/result.json"

# Journal is created only while the exact independently verified v2 baseline is active.
run_prepare "${root}/success" "${root}/prepared.json"
status_is "${root}/prepared.json" SERVICE_CUTOVER_EXECUTION_READY
journal="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["journalPath"])' "${root}/prepared.json")"
test "$(stat -c '%a' "${journal}")" = 600
test "$(stat -c '%a' "$(dirname "${journal}")")" = 700
python3 - "${journal}" "${baseline_verification}" <<'PY'
import hashlib,json,sys
j=json.load(open(sys.argv[1]))['record']; raw=open(sys.argv[2],'rb').read()
assert j['serviceCutoverExecutionJournalVersion']==2
assert j['baselineVerifiedBeforeJournal'] is True
assert j['baselineVerificationFileSha256']=='sha256:'+hashlib.sha256(raw).hexdigest()
assert j['serviceMutationStarted'] is False
assert j['activationExecuted'] is False
PY
run_assess "${journal}" "${root}/inspect/pre" "${root}/ready.json"
status_is "${root}/ready.json" READY_TO_START

# CUTOVER_STARTED is durable before any external mutator is allowed.
run_event "${journal}" "${root}/inspect/pre" CUTOVER_STARTED "${root}/started.json"
status_is "${root}/started.json" EVENT_PERSISTED
run_assess "${journal}" "${root}/inspect/partial" "${root}/partial.json"
status_is "${root}/partial.json" READY_TO_RECREATE_TARGET
python3 - "${root}/partial.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['liveState']=='MIXED_KNOWN'; assert r['serviceMutationAllowed'] is True
PY

# Crash after all target containers changed but before the event: recover evidence, not mutation.
run_assess "${journal}" "${root}/inspect/target" "${root}/recover-target.json"
status_is "${root}/recover-target.json" RECOVER_TARGET_RECREATED
run_event "${journal}" "${root}/inspect/target" TARGET_RECREATED "${root}/target-event.json"
run_assess "${journal}" "${root}/inspect/target" "${root}/ready-validate.json"
status_is "${root}/ready-validate.json" READY_TO_VALIDATE_LIVE

# Terminal activation requires an explicit ENABLED live-attestation artifact first.
printf '{"mode":"CI_LIVE_RUNTIME_ATTESTATION","status":"VERIFIED","backupState":"ENABLED"}\n' >"${root}/live-attestation.json"
chmod 0600 "${root}/live-attestation.json"
run_event "${journal}" "${root}/inspect/target" LIVE_VALIDATED "${root}/validated-event.json" "${root}/live-attestation.json"
run_assess "${journal}" "${root}/inspect/target" "${root}/ready-complete.json"
status_is "${root}/ready-complete.json" READY_TO_COMPLETE
run_event "${journal}" "${root}/inspect/target" COMPLETED "${root}/completed-event.json"
run_assess "${journal}" "${root}/inspect/target" "${root}/completed.json"
status_is "${root}/completed.json" COMPLETED
python3 - "${root}/completed.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['activationExecuted'] is True; assert r['serviceCutoverExecuted'] is True; assert r['liveRuntimeAttested'] is True
PY

# Independent rollback path: ROLLBACK_STARTED is sticky before reverse mutation.
run_prepare "${root}/rollback" "${root}/rollback-prepared.json"
rb_journal="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["journalPath"])' "${root}/rollback-prepared.json")"
run_event "${rb_journal}" "${root}/inspect/pre" CUTOVER_STARTED "${root}/rb-started.json"
run_assess "${rb_journal}" "${root}/inspect/partial" "${root}/rb-partial.json"
status_is "${root}/rb-partial.json" READY_TO_RECREATE_TARGET
run_event "${rb_journal}" "${root}/inspect/partial" ROLLBACK_STARTED "${root}/rollback-started.json"
run_assess "${rb_journal}" "${root}/inspect/partial" "${root}/ready-rb.json"
status_is "${root}/ready-rb.json" READY_TO_RECREATE_ROLLBACK
run_assess "${rb_journal}" "${root}/inspect/rollback" "${root}/recover-rb.json"
status_is "${root}/recover-rb.json" RECOVER_ROLLBACK_RECREATED
run_event "${rb_journal}" "${root}/inspect/rollback" ROLLBACK_RECREATED "${root}/rb-recreated-event.json"
run_assess "${rb_journal}" "${root}/inspect/rollback" "${root}/ready-rb-verify.json"
status_is "${root}/ready-rb-verify.json" READY_TO_VERIFY_ROLLBACK
printf '{"mode":"CI_LIVE_RUNTIME_ATTESTATION","status":"VERIFIED","backupState":"DISABLED"}\n' >"${root}/rollback-attestation.json"
chmod 0600 "${root}/rollback-attestation.json"
run_event "${rb_journal}" "${root}/inspect/rollback" ROLLBACK_VERIFIED "${root}/rb-verified-event.json" "${root}/rollback-attestation.json"
run_assess "${rb_journal}" "${root}/inspect/rollback" "${root}/rolled-back.json"
status_is "${root}/rolled-back.json" ROLLED_BACK
python3 - "${root}/rolled-back.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['activationExecuted'] is False; assert r['serviceCutoverExecuted'] is False
PY

# Preserve identity, application data volumes and Caddy volumes are hard invariants.
for case in caddy-drift volume-drift; do
  set +e
  run_assess "${rb_journal}" "${root}/inspect/${case}" "${root}/${case}.json"
  code=$?
  set -e
  test "${code}" -ne 0
  grep -q '"status":"BLOCKED"' "${root}/${case}.json"
done

# Event tampering breaks the HMAC chain.
started_path="$(dirname "${journal}")/service-cutover-started.json"
cp "${started_path}" "${started_path}.backup"
python3 - "${started_path}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['recordedAt']='2026-08-10T01:01:01.000Z'; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
run_assess "${journal}" "${root}/inspect/target" "${root}/tampered.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'SERVICE_CUTOVER_EXECUTION_EVENT_SIGNATURE_MISMATCH' "${root}/tampered.json"
mv "${started_path}.backup" "${started_path}"; chmod 0600 "${started_path}"

# Evidence-only core contains no Docker/Compose or target-env mutation primitive.
python3 - "${tool}" <<'PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text()
for forbidden in ('docker ', '"docker"', 'compose ', 'subprocess.', 'os.replace(', '.env'):
    assert forbidden not in text, forbidden
assert 'serviceMutationAllowed' in text
assert 'rollbackStartedRequiredBeforeReverseMutation' in text
assert 'activationExecuted' in text
assert 'BASELINE_DOMAIN = b"masters:backup-privacy-service-live-baseline:v2' in text
PY

! grep -R -F 'BETTER_AUTH_SECRET' "${root}/success"

echo 'backup privacy service cutover execution v2 evidence contract: ok'