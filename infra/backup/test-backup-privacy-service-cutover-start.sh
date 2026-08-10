#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${TMPDIR:-/tmp}/backup-privacy-cutover-start"
rm -rf -- "${ROOT}"
mkdir -p "${ROOT}/execution"
chmod 700 "${ROOT}" "${ROOT}/execution"
export ROOT

python3 - <<'PY'
import base64,json,os
from pathlib import Path
root=Path(os.environ['ROOT'])
root.joinpath('key').write_text(base64.b64encode(bytes([101])*32).decode()+'\n')
record={
 'baselineVersion':1,'baselineId':'baseline-'+'1'*32,'cutoverId':'cutover-'+'2'*32,'activationId':'activation-'+'3'*32,
 'baselineFingerprint':'sha256:'+'4'*64,'liveFingerprint':'sha256:'+'5'*64,'cutoverPlanFingerprint':'sha256:'+'6'*64,
 'targetHandoffFingerprint':'sha256:'+'7'*64,'targetEnvFingerprint':'sha256:'+'8'*64,
 'serviceCutoverMutationAllowed':True,'serviceCutoverExecuted':False,'liveRuntimeAttested':False,'activationExecuted':False,
}
root.joinpath('baseline.json').write_text(json.dumps({'envelopeVersion':1,'record':record,'signature':'hmac-sha256:'+'9'*64})+'\n')
for name in ('activation-plan','pending','handoff','club.env','compose.yml','cutover-plan','app-inspect','export-inspect','retention-inspect','libsql-inspect','caddy-inspect'):
    root.joinpath(name).write_text('{}\n')
root.joinpath('fake-baseline-tool.py').write_text(r'''#!/usr/bin/env python3
import argparse,json,sys
p=argparse.ArgumentParser(); p.add_argument('command'); p.add_argument('--baseline',required=True)
for name in ('cutover-plan-checker','handoff-checker','target-config-checker','activation-plan','pending','handoff','key-file','env-file','compose-file','cutover-plan','app-inspect','export-inspect','retention-inspect','libsql-inspect','caddy-inspect'):
    p.add_argument('--'+name)
a=p.parse_args()
try:
    probe=json.load(open(a.app_inspect))
except Exception:
    probe={}
if isinstance(probe,dict) and probe.get('block') is True:
    print(json.dumps({'status':'BLOCKED','blocker':'SIMULATED_LIVE_DRIFT','serviceCutoverMutationAllowed':False,'serviceCutoverExecuted':False,'liveRuntimeAttested':False,'activationExecuted':False})); sys.exit(1)
r=json.load(open(a.baseline))['record']
print(json.dumps({'status':'SERVICE_LIVE_BASELINE_VERIFIED','baselineId':r['baselineId'],'cutoverId':r['cutoverId'],'activationId':r['activationId'],'baselineFingerprint':r['baselineFingerprint'],'liveFingerprint':r['liveFingerprint'],'cutoverPlanFingerprint':r['cutoverPlanFingerprint'],'serviceCutoverMutationAllowed':True,'serviceCutoverExecuted':False,'liveRuntimeAttested':False,'activationExecuted':False}))
''')
PY
chmod 600 "${ROOT}/key" "${ROOT}/baseline.json" "${ROOT}"/{activation-plan,pending,handoff,club.env,compose.yml,cutover-plan,app-inspect,export-inspect,retention-inspect,libsql-inspect,caddy-inspect}
chmod 700 "${ROOT}/fake-baseline-tool.py"

common=(
 --baseline-tool "${ROOT}/fake-baseline-tool.py"
 --cutover-plan-checker "${ROOT}/cutover-plan"
 --handoff-checker "${ROOT}/handoff"
 --activation-plan "${ROOT}/activation-plan"
 --pending "${ROOT}/pending"
 --handoff "${ROOT}/handoff"
 --key-file "${ROOT}/key"
 --env-file "${ROOT}/club.env"
 --compose-file "${ROOT}/compose.yml"
 --cutover-plan "${ROOT}/cutover-plan"
 --app-inspect "${ROOT}/app-inspect"
 --export-inspect "${ROOT}/export-inspect"
 --retention-inspect "${ROOT}/retention-inspect"
 --libsql-inspect "${ROOT}/libsql-inspect"
 --caddy-inspect "${ROOT}/caddy-inspect"
 --baseline "${ROOT}/baseline.json"
)

python3 infra/backup/backup-privacy-service-cutover-execution.py prepare "${common[@]}" \
 --output-root "${ROOT}/execution" --recorded-at 2026-08-10T03:00:00.000Z >"${ROOT}/start.json"
execution="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["executionPath"])' "${ROOT}/start.json")"
export execution
python3 infra/backup/backup-privacy-service-cutover-execution.py check "${common[@]}" --execution "${execution}" >"${ROOT}/check.json"
python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['ROOT']); start=json.loads(root.joinpath('start.json').read_text()); check=json.loads(root.joinpath('check.json').read_text()); rec=json.loads(Path(os.environ['execution']).read_text())['record']
assert start['status']=='CUTOVER_STARTED' and start['executionCreated'] is True and start['executionReused'] is False
assert start['serviceCutoverMutationAllowed'] is True and start['productionMutationApplied'] is False
assert check['status']=='CUTOVER_START_VERIFIED' and check['liveBaselineReverified'] is True
assert rec['phase']=='CUTOVER_STARTED' and rec['recordedAt']=='2026-08-10T03:00:00.000Z'
assert rec['liveBaselineMustRemainVerifiedBeforeMutation'] is True and rec['preserveIdentityRequired'] is True
assert rec['productionMutationApplied'] is False and rec['serviceCutoverExecuted'] is False and rec['activationExecuted'] is False
PY
test "$(stat -c '%a' "$(dirname "${execution}")")" = 700
test "$(stat -c '%a' "${execution}")" = 600

# Retry must reuse the original timestamped execution evidence.
before="$(sha256sum "${execution}" | awk '{print $1}')"
python3 infra/backup/backup-privacy-service-cutover-execution.py prepare "${common[@]}" \
 --output-root "${ROOT}/execution" --recorded-at 2026-08-10T03:05:00.000Z >"${ROOT}/retry.json"
after="$(sha256sum "${execution}" | awk '{print $1}')"
test "${before}" = "${after}"
python3 - "${ROOT}/retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['executionCreated'] is False and r['executionReused'] is True, r
PY

# Baseline must be revalidated every time immediately before mutation.
echo '{"block":true}' >"${ROOT}/app-inspect"; chmod 600 "${ROOT}/app-inspect"
set +e
python3 infra/backup/backup-privacy-service-cutover-execution.py check "${common[@]}" --execution "${execution}" >"${ROOT}/blocked-live.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'LIVE_BASELINE_NOT_VERIFIED' "${ROOT}/blocked-live.json"
echo '{}' >"${ROOT}/app-inspect"; chmod 600 "${ROOT}/app-inspect"

# If the signed baseline artifact itself changes, the durable start evidence no longer matches.
cp "${ROOT}/baseline.json" "${ROOT}/baseline.backup"
python3 - <<'PY'
import json,os
from pathlib import Path
p=Path(os.environ['ROOT'])/'baseline.json'; d=json.loads(p.read_text()); d['record']['liveFingerprint']='sha256:'+'a'*64; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 infra/backup/backup-privacy-service-cutover-execution.py check "${common[@]}" --execution "${execution}" >"${ROOT}/blocked-baseline-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'CUTOVER_EXECUTION_BINDING_MISMATCH' "${ROOT}/blocked-baseline-drift.json"
mv "${ROOT}/baseline.backup" "${ROOT}/baseline.json"; chmod 600 "${ROOT}/baseline.json"

# Execution HMAC/fingerprint tampering is fail-closed.
cp "${execution}" "${execution}.backup"
python3 - "${execution}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['productionMutationApplied']=True; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 infra/backup/backup-privacy-service-cutover-execution.py check "${common[@]}" --execution "${execution}" >"${ROOT}/blocked-execution-tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'CUTOVER_EXECUTION_BINDING_MISMATCH\|CUTOVER_EXECUTION_SIGNATURE_MISMATCH' "${ROOT}/blocked-execution-tamper.json"
mv "${execution}.backup" "${execution}"; chmod 600 "${execution}"

# This slice is evidence-only: no product/service mutation APIs.
python3 - <<'PY'
from pathlib import Path
text=Path('infra/backup/backup-privacy-service-cutover-execution.py').read_text()
assert 'masters:backup-privacy-service-cutover-execution:v1' in text
assert 'CUTOVER_STARTED' in text
assert 'serviceCutoverMutationAllowed' in text
for forbidden in ('docker compose','docker inspect','docker ps','docker run','docker restart','docker stop','docker rm','docker volume','os.replace('):
    assert forbidden not in text, forbidden
PY

grep -F 'PRIVACY_BACKUP_STATE=DISABLED' .env.example
grep -F -- '- [ ] Restore-Drill und RTO-Test' TASKS.md
grep -F -- '- [ ] Backup und Restore praktisch getestet wurden' TASKS.md

echo 'backup privacy service cutover start evidence contract: ok'
