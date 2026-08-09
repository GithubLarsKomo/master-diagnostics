#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
work=/tmp/backup-privacy-live-handoff
base=/tmp/backup-privacy-activation-executor
key="${base}/key"
attestation="${base}/attestations/attestation-66666666666666666666666666666666.json"
planner="${SCRIPT_DIR}/prepare-backup-privacy-activation-plan.py"
plan_checker="${SCRIPT_DIR}/check-backup-privacy-activation-plan.py"
evidence="${SCRIPT_DIR}/backup-privacy-activation-execution.py"
stager="${SCRIPT_DIR}/stage-backup-privacy-live-handoff.py"
checker="${SCRIPT_DIR}/check-backup-privacy-live-handoff.py"

# Reuse the already-proven #226 setup only as a source of authentic drill/manual-attestation prerequisites.
bash "${SCRIPT_DIR}/test-backup-privacy-activation-executor.sh" >/tmp/backup-privacy-live-handoff-prereq.log
rm -rf -- "${work}"
mkdir -p "${work}"
chmod 0700 "${work}"

make_case() {
  local name="$1"
  local root="${work}/${name}"
  mkdir -p "${root}/plans" "${root}/executions"
  chmod 0700 "${root}" "${root}/plans" "${root}/executions"
  printf 'APP_HOST=localhost\nBETTER_AUTH_SECRET=ci-handoff-%s\nPRIVACY_BACKUP_STATE=DISABLED\nPRIVACY_NOTIFICATIONS_STATE=DISABLED\n' "${name}" >"${root}/club.env"
  chmod 0600 "${root}/club.env"
  cp "${root}/club.env" "${root}/original.env"
  chmod 0600 "${root}/original.env"
  python3 "${planner}" \
    --attestation-checker "${SCRIPT_DIR}/check-backup-privacy-manual-attestation.py" \
    --attestation "${attestation}" --key-file "${key}" \
    --env-file "${root}/club.env" --output-dir "${root}/plans" >"${root}/plan-output.json"
  python3 - "${root}" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); result=json.loads(root.joinpath('plan-output.json').read_text())
root.joinpath('plan-path').write_text(result['planPath'])
PY
  local plan
  plan="$(cat "${root}/plan-path")"
  python3 "${evidence}" prepare \
    --plan-checker "${plan_checker}" --plan "${plan}" --key-file "${key}" \
    --env-file "${root}/club.env" --output-root "${root}/executions" \
    --started-at 2026-08-10T00:30:00.000Z >"${root}/pending-output.json"
  python3 - "${root}" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); result=json.loads(root.joinpath('pending-output.json').read_text())
root.joinpath('pending-path').write_text(result['executionPath'])
PY
}

run_stage() {
  local root="$1" out="$2" runtime_checker="${3:-${SCRIPT_DIR}/check-backup-privacy-runtime.sh}"
  local plan pending
  plan="$(cat "${root}/plan-path")"; pending="$(cat "${root}/pending-path")"
  python3 "${stager}" \
    --plan-checker "${plan_checker}" --evidence-checker "${evidence}" --planner "${planner}" \
    --runtime-checker "${runtime_checker}" --plan "${plan}" --pending "${pending}" \
    --key-file "${key}" --env-file "${root}/club.env" --recorded-at 2026-08-10T00:31:00.000Z >"${out}"
}

run_check() {
  local root="$1" out="$2"
  local plan pending
  plan="$(cat "${root}/plan-path")"; pending="$(cat "${root}/pending-path")"
  python3 "${checker}" --plan-checker "${plan_checker}" --evidence-checker "${evidence}" \
    --plan "${plan}" --pending "${pending}" --key-file "${key}" --env-file "${root}/club.env" >"${out}"
}

assert_status() {
  local file="$1" expected="$2"
  python3 - "${file}" "${expected}" <<'PY'
import json,sys
result=json.load(open(sys.argv[1])); assert result['status']==sys.argv[2], result
PY
}

# 1. Canonical production boundary becomes a signed non-terminal handoff, never COMPLETED.
make_case canonical
canonical="${work}/canonical"
run_stage "${canonical}" "${canonical}/result.json"
assert_status "${canonical}/result.json" AWAITING_LIVE_RUNTIME_CUTOVER
grep -Fx 'PRIVACY_BACKUP_STATE=ENABLED' "${canonical}/club.env"
grep -Fx 'BETTER_AUTH_SECRET=ci-handoff-canonical' "${canonical}/club.env"
pending="$(cat "${canonical}/pending-path")"; directory="$(dirname "${pending}")"
handoff="${directory}/activation-execution-live-runtime-handoff.json"
test -f "${handoff}"
test "$(stat -c '%a' "${handoff}")" = 600
test ! -e "${directory}/activation-execution-completed.json"
test ! -e "${directory}/activation-execution-rollback-started.json"
test ! -e "${directory}/activation-execution-rollback-verified.json"
! grep -F 'ci-handoff-canonical' "${handoff}"
run_check "${canonical}" "${canonical}/verified.json"
assert_status "${canonical}/verified.json" LIVE_HANDOFF_VERIFIED
python3 - "${canonical}/verified.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['serviceCutoverPlanningAllowed'] is True; assert r['activationExecuted'] is False; assert r['liveRuntimeAttested'] is False
PY
before="$(sha256sum "${canonical}/club.env" | awk '{print $1}')"
run_stage "${canonical}" "${canonical}/retry.json"
after="$(sha256sum "${canonical}/club.env" | awk '{print $1}')"
test "${before}" = "${after}"
assert_status "${canonical}/retry.json" ALREADY_AWAITING_LIVE_RUNTIME_CUTOVER

# 2. Crash after target write but before handoff evidence is recovered without another env write.
make_case crash-post-write
crash="${work}/crash-post-write"
python3 - "${planner}" "${crash}/club.env" <<'PY'
import importlib.util,sys
from pathlib import Path
planner=Path(sys.argv[1]); env=Path(sys.argv[2]); spec=importlib.util.spec_from_file_location('planner',planner); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
target,_,_=module.build_reversible_target_env(env.read_bytes()); env.write_bytes(target); env.chmod(0o600)
PY
before="$(sha256sum "${crash}/club.env" | awk '{print $1}')"
run_stage "${crash}" "${crash}/result.json"
after="$(sha256sum "${crash}/club.env" | awk '{print $1}')"
test "${before}" = "${after}"
assert_status "${crash}/result.json" AWAITING_LIVE_RUNTIME_CUTOVER
python3 - "${crash}/result.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['envMutationPerformed'] is False
PY

# 3. Any failure other than the exact live-proof boundary still takes the signed #226 rollback path.
make_case unexpected-failure
unexpected="${work}/unexpected-failure"
cat >"${unexpected}/unexpected-runtime.py" <<'PY'
import json,os,sys
state=os.environ.get('PRIVACY_BACKUP_STATE')
if state=='ENABLED':
    print(json.dumps({'readyForIrreversibleProcessing':False,'backupState':'ENABLED','notificationsState':'DISABLED','backupPolicyVersion':'1.0.0','notificationPolicyVersion':None,'blockers':['SIMULATED_UNEXPECTED_TARGET_FAILURE']},separators=(',',':')))
    raise SystemExit(1)
if state=='DISABLED':
    print(json.dumps({'readyForIrreversibleProcessing':True,'backupState':'DISABLED','notificationsState':'DISABLED','backupPolicyVersion':None,'notificationPolicyVersion':None,'blockers':[]},separators=(',',':')))
    raise SystemExit(0)
print('{}'); raise SystemExit(1)
PY
chmod 0700 "${unexpected}/unexpected-runtime.py"
set +e
run_stage "${unexpected}" "${unexpected}/result.json" "${unexpected}/unexpected-runtime.py"
code=$?
set -e
test "${code}" -eq 1
assert_status "${unexpected}/result.json" ROLLED_BACK
cmp -s "${unexpected}/club.env" "${unexpected}/original.env"
pending="$(cat "${unexpected}/pending-path")"; directory="$(dirname "${pending}")"
test -f "${directory}/activation-execution-rollback-started.json"
test -f "${directory}/activation-execution-rollback-verified.json"
test ! -e "${directory}/activation-execution-live-runtime-handoff.json"

# 4. Handoff HMAC/fingerprint tampering fails closed.
python3 - "${handoff}" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]); data=json.loads(path.read_text()); data['record']['recordedAt']='2026-08-10T00:31:01.000Z'; path.write_text(json.dumps(data,indent=2)+'\n'); path.chmod(0o600)
PY
set +e
run_check "${canonical}" "${canonical}/tampered.json"
code=$?
set -e
test "${code}" -ne 0
python3 - "${canonical}/tampered.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='BLOCKED'; assert r['blocker'] in {'LIVE_HANDOFF_FINGERPRINT_MISMATCH','LIVE_HANDOFF_SIGNATURE_MISMATCH'}
PY

# 5. A synthetic terminal #226 completion is not accepted as a non-terminal production handoff.
success="${base}/success"
set +e
run_check "${success}" "${work}/completed-conflict.json"
code=$?
set -e
test "${code}" -ne 0
python3 - "${work}/completed-conflict.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='BLOCKED'; assert r['blocker']=='LIVE_HANDOFF_TERMINAL_COMPLETION_CONFLICT'
PY

echo 'backup privacy live handoff contract: OK'
