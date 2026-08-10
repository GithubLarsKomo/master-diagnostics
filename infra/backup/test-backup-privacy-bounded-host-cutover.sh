#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
host="${SCRIPT_DIR}/execute-backup-privacy-service-cutover-host.py"
activation_fixture=/tmp/backup-privacy-activation-executor/success
baseline_fixture=/tmp/backup-privacy-service-live-baseline-v2-fixture
execution_fixture=/tmp/backup-privacy-service-cutover-execution-v2
key=/tmp/backup-privacy-activation-executor/key

# Build the real signed chain first, while the runner still uses its real Docker.
bash "${SCRIPT_DIR}/test-backup-privacy-service-cutover-execution.sh" >/dev/null
cutover_plan="$(cat "${activation_fixture}/cutover-v2-plan-path")"
baseline="$(cat "${baseline_fixture}/baseline-path.txt")"
env_file="${activation_fixture}/club.env"
rendered="${baseline_fixture}/live-baseline-rendered-compose.json"
pre_inspect="${execution_fixture}/inspect/pre"

test -f "${cutover_plan}"; test -f "${baseline}"; test -f "${rendered}"
fixture=/tmp/backup-privacy-bounded-host-cutover
rm -rf "${fixture}"; mkdir -p "${fixture}/bin"; chmod 0700 "${fixture}"
cp "${env_file}" "${fixture}/target.env"; chmod 0600 "${fixture}/target.env"

# Seed a stateful fake Docker daemon from the execution fixture, restoring the
# raw Docker metadata intentionally omitted by the execution-only snapshots but
# required by independent Baseline-v2 re-verification.
python3 - "${pre_inspect}" "${baseline}" "${fixture}/pre-state.json" <<'PY'
import json,sys
from pathlib import Path
source=Path(sys.argv[1])
baseline=json.loads(Path(sys.argv[2]).read_text())['record']
signed={item['service']:item for item in baseline['containers']}
state={}
for service in ('app','export-cleanup','retention-scan','libsql','caddy'):
    item=json.loads((source/f'{service}.json').read_text())[0]
    snap=signed[service]
    item.setdefault('State',{})['StartedAt']=snap['startedAt']
    item['RestartCount']=snap['restartCount']
    item['Name']='/'+snap['containerName']
    state[service]=item
Path(sys.argv[3]).write_text(json.dumps(state)+'\n')
PY

cat >"${fixture}/bin/docker" <<'PY'
#!/usr/bin/env python3
import json,os,signal,sys
from pathlib import Path

state_path=Path(os.environ['FAKE_DOCKER_STATE'])
log_path=Path(os.environ['FAKE_DOCKER_LOG'])
rendered_path=Path(os.environ['FAKE_DOCKER_RENDERED'])
args=sys.argv[1:]

def load(): return json.loads(state_path.read_text())
def save(value): state_path.write_text(json.dumps(value)+'\n')
def log(extra=None):
    with log_path.open('a') as h: h.write(json.dumps({'args':args, **(extra or {})})+'\n')
def env_path():
    try: return Path(args[args.index('--env-file')+1])
    except Exception: return None

def service_filter():
    prefix='label=com.docker.compose.service='
    for i,arg in enumerate(args):
        if arg=='--filter' and i+1<len(args) and args[i+1].startswith(prefix): return args[i+1][len(prefix):]
    return None

def privacy_state(path):
    values={}
    if path and path.exists():
        for line in path.read_text().splitlines():
            if '=' in line:
                k,v=line.split('=',1); values[k]=v
    return values.get('PRIVACY_BACKUP_STATE')

def mutate(service, backup):
    state=load(); item=state[service]
    counter_file=Path(os.environ['FAKE_DOCKER_COUNTER_FILE'])
    counter=int(counter_file.read_text()) if counter_file.exists() else 0
    counter+=1; counter_file.write_text(str(counter))
    item['Id']=(format((counter % 14)+1,'x')*64)[:64]
    env=[x for x in item['Config'].get('Env',[]) if not x.startswith('PRIVACY_BACKUP_') and not x.startswith('PRIVACY_NOTIFICATIONS_')]
    if backup=='ENABLED':
        env += [
            'PRIVACY_BACKUP_STATE=ENABLED',
            'PRIVACY_BACKUP_POLICY_VERSION=1.0.0',
            'PRIVACY_BACKUP_ENCRYPTED_AT_REST=true',
            'PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true',
            'PRIVACY_BACKUP_RESTORE_RECONCILIATION=true',
            'PRIVACY_NOTIFICATIONS_STATE=DISABLED',
        ]
    else:
        env += ['PRIVACY_BACKUP_STATE=DISABLED','PRIVACY_NOTIFICATIONS_STATE=DISABLED']
    item['Config']['Env']=env
    item['State']['Status']='running'; item['State']['Running']=True
    item['State']['StartedAt']=f'2026-08-10T03:00:{counter:02d}.000000000Z'
    item['RestartCount']=int(item.get('RestartCount') or 0)+1
    if service=='app': item['State']['Health']={'Status':'healthy'}
    state[service]=item; save(state)

if args and args[0]=='ps':
    service=service_filter(); state=load(); log()
    if service in state: print(state[service]['Id'])
    sys.exit(0)

if args and args[0]=='inspect':
    target=args[1]; state=load(); log()
    for item in state.values():
        if item['Id']==target:
            print(json.dumps([item])); sys.exit(0)
    sys.exit(1)

if args and args[0]=='compose':
    if 'config' in args:
        log({'kind':'config'}); sys.stdout.write(rendered_path.read_text()); sys.exit(0)
    if 'run' in args and args[-1]=='privacy-check':
        log({'kind':'preflight'})
        print(json.dumps({
            'readyForIrreversibleProcessing':True,
            'backupState':'ENABLED',
            'notificationsState':'DISABLED',
            'backupPolicyVersion':'1.0.0',
            'notificationPolicyVersion':None,
            'blockers':[],
        }))
        sys.exit(0)
    if 'up' in args:
        service=args[-1]; backup=privacy_state(env_path()); log({'kind':'up','service':service,'backup':backup})
        fail_service=os.environ.get('FAKE_DOCKER_FAIL_SERVICE')
        fail_marker=Path(os.environ['FAKE_DOCKER_FAIL_MARKER'])
        if service==fail_service and not fail_marker.exists():
            fail_marker.write_text(service); print('injected recreate failure',file=sys.stderr); sys.exit(44)
        mutate(service,backup)
        crash_service=os.environ.get('FAKE_DOCKER_CRASH_AFTER_SERVICE')
        crash_marker=Path(os.environ['FAKE_DOCKER_CRASH_MARKER'])
        if service==crash_service and not crash_marker.exists():
            crash_marker.write_text(service)
            os.kill(os.getppid(), signal.SIGKILL)
        sys.exit(0)

log({'kind':'unexpected'}); print('unexpected fake docker invocation: '+repr(args),file=sys.stderr); sys.exit(64)
PY
chmod 0755 "${fixture}/bin/docker"

export PATH="${fixture}/bin:${PATH}"
export FAKE_DOCKER_RENDERED="${rendered}"
export FAKE_DOCKER_STATE="${fixture}/state.json"
export FAKE_DOCKER_LOG="${fixture}/docker.log"
export FAKE_DOCKER_COUNTER_FILE="${fixture}/counter"
export FAKE_DOCKER_FAIL_MARKER="${fixture}/fail.marker"
export FAKE_DOCKER_CRASH_MARKER="${fixture}/crash.marker"

reset_fixture() {
  cp "${fixture}/pre-state.json" "${FAKE_DOCKER_STATE}"
  : >"${FAKE_DOCKER_LOG}"
  echo 0 >"${FAKE_DOCKER_COUNTER_FILE}"
  rm -f "${FAKE_DOCKER_FAIL_MARKER}" "${FAKE_DOCKER_CRASH_MARKER}"
  cp "${fixture}/target.env" "${env_file}"; chmod 0600 "${env_file}"
  unset FAKE_DOCKER_FAIL_SERVICE FAKE_DOCKER_CRASH_AFTER_SERVICE || true
}

run_host() {
  local name="$1"
  python3 "${host}" \
    --cutover-plan "${cutover_plan}" \
    --baseline "${baseline}" \
    --key-file "${key}" \
    --execution-root "${fixture}/${name}-execution" \
    --evidence-root "${fixture}/${name}-evidence"
}

cutover_id="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["record"]["cutoverId"])' "${cutover_plan}")"

# Success: preflight precedes exactly one target recreate of each mutable service.
reset_fixture
run_host success >"${fixture}/success.json"
python3 - "${fixture}/success.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='COMPLETED',r
assert r['activationExecuted'] is True and r['serviceCutoverExecuted'] is True and r['liveRuntimeAttested'] is True
assert r['automaticRollback'] is False
PY
python3 - "${FAKE_DOCKER_LOG}" <<'PY'
import json,sys
entries=[json.loads(x) for x in open(sys.argv[1])]
meaningful=[e for e in entries if e.get('kind') in {'preflight','up'}]
assert meaningful[0]['kind']=='preflight', meaningful
ups=[e for e in meaningful if e.get('kind')=='up']
assert [(e['service'],e['backup']) for e in ups]==[
 ('export-cleanup','ENABLED'),('retention-scan','ENABLED'),('app','ENABLED')
],ups
assert all(e['service'] not in {'libsql','caddy'} for e in ups)
PY

# Real process crash after first recreate: retry must reuse proof and not recreate that service twice.
reset_fixture
export FAKE_DOCKER_CRASH_AFTER_SERVICE=export-cleanup
set +e
run_host crash >"${fixture}/crash-first.json"
crash_code=$?
set -e
test "${crash_code}" -ne 0
test -f "${fixture}/crash-evidence/preflight/preflight-proof.json"
test -f "${fixture}/crash-execution/${cutover_id}/service-cutover-started.json"
unset FAKE_DOCKER_CRASH_AFTER_SERVICE
run_host crash >"${fixture}/crash-retry.json"
python3 - "${fixture}/crash-retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='COMPLETED',r; assert r['activationExecuted'] is True
PY
python3 - "${FAKE_DOCKER_LOG}" <<'PY'
import json,sys
entries=[json.loads(x) for x in open(sys.argv[1])]
ups=[e for e in entries if e.get('kind')=='up' and e.get('backup')=='ENABLED']
assert [e['service'] for e in ups].count('export-cleanup')==1,ups
assert [e['service'] for e in ups].count('retention-scan')==1,ups
assert [e['service'] for e in ups].count('app')==1,ups
assert sum(1 for e in entries if e.get('kind')=='preflight')==1,entries
PY

# If the historical proof disappears after a crash with visible mutation, retry is fail-closed and makes no new mutation.
reset_fixture
export FAKE_DOCKER_CRASH_AFTER_SERVICE=export-cleanup
set +e
run_host missing >"${fixture}/missing-first.json"
missing_crash=$?
set -e
test "${missing_crash}" -ne 0
rm -f "${fixture}/missing-evidence/preflight/preflight-proof.json"
before="$(grep -c '"kind": "up"' "${FAKE_DOCKER_LOG}" || true)"
unset FAKE_DOCKER_CRASH_AFTER_SERVICE
set +e
run_host missing >"${fixture}/missing-retry.json"
missing_code=$?
set -e
test "${missing_code}" -eq 2
grep -F 'HOST_CUTOVER_PREFLIGHT_PROOF_MISSING_AFTER_MUTATION' "${fixture}/missing-retry.json"
after="$(grep -c '"kind": "up"' "${FAKE_DOCKER_LOG}" || true)"
test "${before}" = "${after}"

# Controlled target failure after one successful recreate triggers sticky rollback, byte-exact env restoration and DISABLED re-attestation.
reset_fixture
export FAKE_DOCKER_FAIL_SERVICE=retention-scan
run_host rollback >"${fixture}/rollback.json"
python3 - "${fixture}/rollback.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='ROLLED_BACK',r
assert r['activationExecuted'] is False and r['serviceCutoverExecuted'] is False
assert r['automaticRollback'] is True and r['targetFailure']
PY
grep -F 'PRIVACY_BACKUP_STATE=DISABLED' "${env_file}"
python3 - "${FAKE_DOCKER_STATE}" <<'PY'
import json,sys
state=json.load(open(sys.argv[1]))
for service in ('app','export-cleanup','retention-scan'):
    env=state[service]['Config']['Env']
    assert 'PRIVACY_BACKUP_STATE=DISABLED' in env,(service,env)
    assert 'PRIVACY_NOTIFICATIONS_STATE=DISABLED' in env,(service,env)
PY
python3 - "${FAKE_DOCKER_LOG}" <<'PY'
import json,sys
entries=[json.loads(x) for x in open(sys.argv[1])]
ups=[e for e in entries if e.get('kind')=='up']
assert ('export-cleanup','ENABLED') in [(e['service'],e['backup']) for e in ups],ups
assert ('export-cleanup','DISABLED') in [(e['service'],e['backup']) for e in ups],ups
assert all(e['service'] not in {'libsql','caddy'} for e in ups)
PY
test -f "${fixture}/rollback-execution/${cutover_id}/service-cutover-rollback-started.json"
test -f "${fixture}/rollback-execution/${cutover_id}/service-cutover-rollback-verified.json"

# Static host policy: only the signed mutable set is passed to force-recreate; preserved services are never mutation targets.
python3 - "${host}" <<'PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text()
assert '"--force-recreate"' in text and '"--no-deps"' in text and '"--no-build"' in text and '"--pull", "never"' in text
assert 'MUTABLE = ("export-cleanup", "retention-scan", "app")' in text
assert 'PRESERVED = ("libsql", "caddy")' in text
assert 'ROLLBACK_STARTED' in text
assert 'privacy-check' in text
assert 'preflight-proof.json' in text
assert 'target-attestation.json' in text and 'rollback-attestation.json' in text
PY

echo 'backup privacy bounded host cutover contract: ok'