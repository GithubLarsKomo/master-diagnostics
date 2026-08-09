#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

# Reuse the complete signed Target-Handoff -> Service-Cutover-Plan-v2 contract.
bash infra/backup/test-backup-privacy-service-cutover-plan.sh >/dev/null

fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
key="${fixture}/key"
activation_plan="$(cat "${success}/plan-path")"
pending="$(cat "${success}/pending-path")"
handoff="$(dirname "${pending}")/activation-target-handoff.json"
env_file="${success}/club.env"
cutover_plan="$(cat "${success}/cutover-plan-v2-path")"
target_config_checker="${fixture}/target-config-checker.py"
baseline_root="${fixture}/live-baselines"
mkdir -p "${baseline_root}"; chmod 0700 "${baseline_root}"

cleanup() { rm -f -- "${ROOT_DIR}/.env"; }
trap cleanup EXIT
cp "${env_file}" "${ROOT_DIR}/.env"
chmod 0600 "${ROOT_DIR}/.env"

docker compose --env-file "${env_file}" -f "${ROOT_DIR}/infra/docker-compose.club.yml" config --format json >"${success}/rendered-for-baseline.json"
project="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "${success}/rendered-for-baseline.json")"
export success project

python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['success']); project=os.environ['project']

def cid(ch): return ch*64
def image(ch): return 'sha256:'+ch*64

def inspect(service,ch,image_ref,env=None,mounts=None,healthy=False):
    state={'Status':'running','Running':True}
    if healthy: state['Health']={'Status':'healthy'}
    return [{
        'Id':cid(ch),
        'Image':image(ch),
        'Config':{
            'Image':image_ref,
            'Labels':{'com.docker.compose.project':project,'com.docker.compose.service':service},
            'Env':[f'{k}={v}' for k,v in (env or {}).items()],
        },
        'State':state,
        'Mounts':mounts or [],
    }]

def volume(name,destination):
    return {'Type':'volume','Name':name,'Destination':destination,'RW':True}

old_env={'PRIVACY_BACKUP_STATE':'DISABLED','PRIVACY_NOTIFICATIONS_STATE':'DISABLED'}
records={
'app':inspect('app','1','master-diagnostics-app:test',old_env,[
 volume('infra_report-data','/var/lib/masters/reports'),
 volume('infra_export-data','/var/lib/masters/exports'),
 volume('infra_data-subject-delivery-data','/var/lib/masters/data-subject-delivery-packages'),
],True),
'export-cleanup':inspect('export-cleanup','2','master-diagnostics-migrator:test',old_env,[
 volume('infra_export-data','/var/lib/masters/exports'),
 volume('infra_data-subject-delivery-data','/var/lib/masters/data-subject-delivery-packages'),
]),
'retention-scan':inspect('retention-scan','3','master-diagnostics-migrator:test',old_env,[]),
'libsql':inspect('libsql','4','ghcr.io/tursodatabase/libsql-server:3ec6803',{},[
 volume('infra_libsql-data','/var/lib/sqld'),
],True),
'caddy':inspect('caddy','5','caddy:2.11.3-alpine',{},[
 volume('infra_caddy-data','/data'),
 volume('infra_caddy-config','/config'),
]),
}
for name,value in records.items():
    root.joinpath(f'{name}-inspect.json').write_text(json.dumps(value)+'\n')
PY

common=(
  --cutover-plan-checker "${ROOT_DIR}/infra/backup/check-backup-privacy-service-cutover-plan.py"
  --handoff-checker "${ROOT_DIR}/infra/backup/check-backup-privacy-target-handoff.py"
  --activation-plan-checker "${ROOT_DIR}/infra/backup/check-backup-privacy-activation-plan.py"
  --execution-evidence-checker "${ROOT_DIR}/infra/backup/backup-privacy-activation-execution.py"
  --target-config-checker "${target_config_checker}"
  --activation-plan "${activation_plan}"
  --pending "${pending}"
  --handoff "${handoff}"
  --key-file "${key}"
  --env-file "${env_file}"
  --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml"
  --cutover-plan "${cutover_plan}"
  --app-inspect "${success}/app-inspect.json"
  --export-cleanup-inspect "${success}/export-cleanup-inspect.json"
  --retention-scan-inspect "${success}/retention-scan-inspect.json"
  --libsql-inspect "${success}/libsql-inspect.json"
  --caddy-inspect "${success}/caddy-inspect.json"
)

python3 infra/backup/backup-privacy-service-live-baseline.py prepare "${common[@]}" \
  --output-root "${baseline_root}" --recorded-at 2026-08-10T02:00:00.000Z >"${success}/baseline-output.json"
baseline="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baselinePath"])' "${success}/baseline-output.json")"
export baseline
python3 infra/backup/backup-privacy-service-live-baseline.py check "${common[@]}" --baseline "${baseline}" >"${success}/baseline-check.json"

python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['success'])
p=json.loads(root.joinpath('baseline-output.json').read_text())
c=json.loads(root.joinpath('baseline-check.json').read_text())
b=json.loads(Path(os.environ['baseline']).read_text())['record']
assert p['status']=='LIVE_BASELINE_READY' and p['baselineCreated'] is True and p['baselineReused'] is False
assert p['serviceCutoverExecutionAllowed'] is True and p['serviceCutoverExecuted'] is False
assert c['status']=='LIVE_BASELINE_VERIFIED' and c['serviceCutoverExecutionAllowed'] is True
assert c['preserveIdentityRequired'] is True and c['activationExecuted'] is False
assert b['livePreCutoverBackupState']=='DISABLED'
assert b['recreateServices']==['app','export-cleanup','retention-scan']
assert b['preserveServices']==['libsql','caddy']
assert b['preservedContainerIds']=={'libsql':'4'*64,'caddy':'5'*64}
assert b['dataVolumes']=={
 'libsql':'infra_libsql-data','reports':'infra_report-data','tenantExports':'infra_export-data','dataSubjectDelivery':'infra_data-subject-delivery-data'}
assert b['caddyVolumes']=={'caddyData':'infra_caddy-data','caddyConfig':'infra_caddy-config'}
assert b['serviceCutoverExecuted'] is False and b['liveRuntimeAttested'] is False and b['activationExecuted'] is False
# No secret or full env values are persisted.
text=Path(os.environ['baseline']).read_text()
assert 'ci-secret-value' not in text
assert 'BETTER_AUTH_SECRET' not in text
PY

test "$(stat -c '%a' "$(dirname "${baseline}")")" = 700
test "$(stat -c '%a' "${baseline}")" = 600

# Deterministic retry reuses the original timestamped evidence.
python3 infra/backup/backup-privacy-service-live-baseline.py prepare "${common[@]}" \
  --output-root "${baseline_root}" --recorded-at 2026-08-10T02:01:00.000Z >"${success}/baseline-retry.json"
python3 - "${success}/baseline-retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['baselineCreated'] is False and r['baselineReused'] is True, r
PY

# A recreate-service that is already ENABLED cannot be accepted as a pre-cutover baseline.
cp "${success}/retention-scan-inspect.json" "${success}/retention-scan-inspect.backup"
python3 - "${success}/retention-scan-inspect.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d[0]['Config']['Env']=['PRIVACY_BACKUP_STATE=ENABLED']; p.write_text(json.dumps(d)+'\n')
PY
set +e
python3 infra/backup/backup-privacy-service-live-baseline.py check "${common[@]}" --baseline "${baseline}" >"${success}/baseline-enabled-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'LIVE_BASELINE_PRIVACY_STATE_NOT_DISABLED' "${success}/baseline-enabled-drift.json"
mv "${success}/retention-scan-inspect.backup" "${success}/retention-scan-inspect.json"

# Preserve-container identity drift after baseline is fail-closed.
cp "${success}/caddy-inspect.json" "${success}/caddy-inspect.backup"
python3 - "${success}/caddy-inspect.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d[0]['Id']='6'*64; p.write_text(json.dumps(d)+'\n')
PY
set +e
python3 infra/backup/backup-privacy-service-live-baseline.py check "${common[@]}" --baseline "${baseline}" >"${success}/baseline-preserve-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'LIVE_BASELINE_STATE_DRIFT' "${success}/baseline-preserve-drift.json"
mv "${success}/caddy-inspect.backup" "${success}/caddy-inspect.json"

# Background volume mismatch is blocked before signing/reuse.
cp "${success}/export-cleanup-inspect.json" "${success}/export-cleanup-inspect.backup"
python3 - "${success}/export-cleanup-inspect.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d[0]['Mounts'][0]['Name']='unexpected-export-volume'; p.write_text(json.dumps(d)+'\n')
PY
set +e
python3 infra/backup/backup-privacy-service-live-baseline.py check "${common[@]}" --baseline "${baseline}" >"${success}/baseline-volume-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'LIVE_BASELINE_BACKGROUND_VOLUME_MISMATCH' "${success}/baseline-volume-drift.json"
mv "${success}/export-cleanup-inspect.backup" "${success}/export-cleanup-inspect.json"

# Baseline HMAC/fingerprint tampering is independently blocked.
cp "${baseline}" "${baseline}.backup"
python3 - "${baseline}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['activationExecuted']=True; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 infra/backup/backup-privacy-service-live-baseline.py check "${common[@]}" --baseline "${baseline}" >"${success}/baseline-tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'LIVE_BASELINE_STATE_DRIFT\|LIVE_BASELINE_BOUNDARY_INVALID\|LIVE_BASELINE_FINGERPRINT_MISMATCH\|LIVE_BASELINE_SIGNATURE_MISMATCH' "${success}/baseline-tamper.json"
mv "${baseline}.backup" "${baseline}"
chmod 0600 "${baseline}"

# This slice may only render Compose and read inspect evidence; it cannot mutate Docker.
python3 - <<'PY'
from pathlib import Path
text=Path('infra/backup/backup-privacy-service-live-baseline.py').read_text()
assert '"config", "--format", "json"' in text
for forbidden in ('docker inspect','docker ps','docker run','docker restart','docker stop','docker rm','docker volume','os.replace('):
    assert forbidden not in text, forbidden
assert 'serviceCutoverExecutionAllowed' in text
assert 'preserveIdentityRequired' in text
PY

grep -F 'PRIVACY_BACKUP_STATE=DISABLED' .env.example
grep -F -- '- [ ] Restore-Drill und RTO-Test' TASKS.md
grep -F -- '- [ ] Backup und Restore praktisch getestet wurden' TASKS.md

echo 'backup privacy service live baseline contract: ok'
