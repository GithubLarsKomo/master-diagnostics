#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
work=/tmp/backup-privacy-activation-executor
key="${work}/key"
attestation="${work}/attestations/attestation-66666666666666666666666666666666.json"
executor="${SCRIPT_DIR}/execute-backup-privacy-activation.py"
evidence="${SCRIPT_DIR}/backup-privacy-activation-execution.py"
plan_checker="${SCRIPT_DIR}/check-backup-privacy-activation-plan.py"
planner="${SCRIPT_DIR}/prepare-backup-privacy-activation-plan.py"
runtime_checker="${work}/runtime-checker.py"
bundle_name=masters-backup-20260810T000000Z-55555555-5555-5555-5555-555555555555.mdbak
bundle="${work}/${bundle_name}"

rm -rf -- "${work}"
mkdir -p "${work}/reports" "${work}/attestations"
chmod 0700 "${work}/reports" "${work}/attestations"
printf 'activation-executor-bound-backup\n' >"${bundle}"
bundle_fp="sha256:$(sha256sum "${bundle}" | awk '{print $1}')"
python3 - <<'PY'
import base64,json
from pathlib import Path
root=Path('/tmp/backup-privacy-activation-executor')
root.joinpath('key').write_text(base64.b64encode(bytes([91])*32).decode()+'\n')
phases=[{'name':n,'status':'COMPLETED','durationSeconds':10,'exitCode':0} for n in ('VERIFY_BACKUP','STAGE_RESTORE','PRIVACY_REPLAY','AUTHORIZE_PROMOTION','PREPARE_PROMOTION_PLAN','PREPARE_CANDIDATES','AUTHORIZE_SWITCH','EXECUTE_SWITCH')]
root.joinpath('phases.json').write_text(json.dumps(phases)+'\n')
root.joinpath('runtime-checker.py').write_text(r'''import json,os,sys
state=os.environ.get("PRIVACY_BACKUP_STATE")
mode=os.environ.get("TEST_RUNTIME_MODE","success")
if state == "ENABLED":
    expected={
        "PRIVACY_BACKUP_POLICY_VERSION":"1.0.0",
        "PRIVACY_BACKUP_ENCRYPTED_AT_REST":"true",
        "PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED":"true",
        "PRIVACY_BACKUP_RESTORE_RECONCILIATION":"true",
    }
    good=all(os.environ.get(k)==v for k,v in expected.items()) and mode != "fail-target"
    result={"readyForIrreversibleProcessing":good,"backupState":"ENABLED","notificationsState":os.environ.get("PRIVACY_NOTIFICATIONS_STATE","UNDECLARED"),"backupPolicyVersion":"1.0.0","notificationPolicyVersion":"1.0.0","blockers":[] if good else ["SIMULATED_TARGET_FAILURE"]}
elif state == "DISABLED":
    good=mode != "fail-rollback" and os.environ.get("PRIVACY_NOTIFICATIONS_STATE") == "DISABLED"
    result={"readyForIrreversibleProcessing":good,"backupState":"DISABLED","notificationsState":os.environ.get("PRIVACY_NOTIFICATIONS_STATE","UNDECLARED"),"backupPolicyVersion":"1.0.0","notificationPolicyVersion":"1.0.0","blockers":[] if good else ["SIMULATED_ROLLBACK_FAILURE"]}
else:
    good=False
    result={"readyForIrreversibleProcessing":False,"backupState":state or "UNDECLARED","notificationsState":os.environ.get("PRIVACY_NOTIFICATIONS_STATE","UNDECLARED"),"backupPolicyVersion":"1.0.0","notificationPolicyVersion":"1.0.0","blockers":["BACKUP_CAPABILITY_STATE_REQUIRED"]}
print(json.dumps(result,separators=(",",":")))
raise SystemExit(0 if good else 1)
''')
PY
chmod 0600 "${key}" "${work}/phases.json" "${runtime_checker}"

python3 "${SCRIPT_DIR}/write-restore-rto-drill-report.py" \
  --output-dir "${work}/reports" --key-file "${key}" \
  --drill-id drill-55555555555555555555555555555555 \
  --bundle-name "${bundle_name}" --bundle-sha256 "${bundle_fp}" \
  --staging-name restore-20260810T000100Z-66666666-6666-6666-6666-666666666666 \
  --candidate-set-id restore-0123456789abcdefabcd \
  --started-at 2026-08-10T00:00:00.000Z --completed-at 2026-08-10T00:02:00.000Z \
  --duration-seconds 120 --status COMPLETED --terminal-phase EXECUTE_SWITCH \
  --phases-file "${work}/phases.json" >/dev/null
PRIVACY_BACKUP_STATE=DISABLED python3 "${SCRIPT_DIR}/write-backup-privacy-manual-attestation.py" \
  --readiness-checker "${SCRIPT_DIR}/check-backup-privacy-activation-readiness.py" \
  --drill-report "${work}/reports/drill-55555555555555555555555555555555.json" \
  --drill-key-file "${key}" --backup-bundle "${bundle}" --attestation-key-file "${key}" \
  --output-dir "${work}/attestations" --attestation-id attestation-66666666666666666666666666666666 \
  --attestor-id ci-executor --attested-at 2026-08-10T00:05:00.000Z \
  --acknowledge-operational-responsibility >/dev/null

make_case() {
  local name="$1"
  local root="${work}/${name}"
  mkdir -p "${root}/plans" "${root}/executions"
  chmod 0700 "${root}" "${root}/plans" "${root}/executions"
  printf 'APP_HOST=localhost\nBETTER_AUTH_SECRET=ci-secret-%s\nPRIVACY_BACKUP_STATE=DISABLED\nPRIVACY_NOTIFICATIONS_STATE=DISABLED\n' "${name}" >"${root}/club.env"
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
    --started-at 2026-08-10T00:06:00.000Z >"${root}/pending-output.json"
  python3 - "${root}" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); result=json.loads(root.joinpath('pending-output.json').read_text())
root.joinpath('pending-path').write_text(result['executionPath'])
PY
}

run_executor() {
  local root="$1" out="$2"
  local plan pending
  plan="$(cat "${root}/plan-path")"; pending="$(cat "${root}/pending-path")"
  python3 "${executor}" \
    --plan-checker "${plan_checker}" --evidence-checker "${evidence}" --planner "${planner}" \
    --runtime-checker "${runtime_checker}" --plan "${plan}" --pending "${pending}" \
    --key-file "${key}" --env-file "${root}/club.env" --recorded-at 2026-08-10T00:07:00.000Z >"${out}"
}

assert_status() {
  local file="$1" expected="$2"
  python3 - "${file}" "${expected}" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
assert result['status']==sys.argv[2], result
PY
}

# 1. Normal bounded activation writes only the plan-bound target and becomes idempotently terminal.
make_case success
success="${work}/success"
run_executor "${success}" "${success}/result.json"
assert_status "${success}/result.json" COMPLETED
grep -Fx 'APP_HOST=localhost' "${success}/club.env"
grep -Fx 'BETTER_AUTH_SECRET=ci-secret-success' "${success}/club.env"
grep -Fx 'PRIVACY_BACKUP_STATE=ENABLED' "${success}/club.env"
grep -Fx 'PRIVACY_BACKUP_POLICY_VERSION=1.0.0' "${success}/club.env"
grep -Fx 'PRIVACY_BACKUP_ENCRYPTED_AT_REST=true' "${success}/club.env"
grep -Fx 'PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true' "${success}/club.env"
grep -Fx 'PRIVACY_BACKUP_RESTORE_RECONCILIATION=true' "${success}/club.env"
grep -Fx 'PRIVACY_NOTIFICATIONS_STATE=DISABLED' "${success}/club.env"
pending="$(cat "${success}/pending-path")"; evidence_dir="$(dirname "${pending}")"
test -f "${evidence_dir}/activation-execution-completed.json"
test "$(stat -c '%a' "${evidence_dir}/activation-execution-completed.json")" = 600
! grep -R -F 'ci-secret-success' "${evidence_dir}" --include='*.json'
run_executor "${success}" "${success}/retry.json"
assert_status "${success}/retry.json" ALREADY_COMPLETED

# 2. Crash after target replace is recovered from READY_TO_VALIDATE without another write.
make_case crash-post-write
crash="${work}/crash-post-write"
python3 - "${planner}" "${crash}/club.env" <<'PY'
import importlib.util,sys
from pathlib import Path
planner=Path(sys.argv[1]); env=Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('planner',planner); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
target,_,_=module.build_reversible_target_env(env.read_bytes()); env.write_bytes(target); env.chmod(0o600)
PY
before="$(sha256sum "${crash}/club.env" | awk '{print $1}')"
run_executor "${crash}" "${crash}/result.json"
after="$(sha256sum "${crash}/club.env" | awk '{print $1}')"
test "${before}" = "${after}"
assert_status "${crash}/result.json" COMPLETED

# 3. Failed post-write attestation durably starts rollback, restores byte-exact original and stays terminal.
make_case rollback
rollback="${work}/rollback"
set +e
TEST_RUNTIME_MODE=fail-target run_executor "${rollback}" "${rollback}/result.json"
code=$?
set -e
test "${code}" -eq 1
assert_status "${rollback}/result.json" ROLLED_BACK
cmp -s "${rollback}/club.env" "${rollback}/original.env"
pending="$(cat "${rollback}/pending-path")"; evidence_dir="$(dirname "${pending}")"
test -f "${evidence_dir}/activation-execution-rollback-started.json"
test -f "${evidence_dir}/activation-execution-rollback-verified.json"
# Simulate crash after byte rollback but before terminal rollback evidence.
rm "${evidence_dir}/activation-execution-rollback-verified.json"
set +e
TEST_RUNTIME_MODE=success run_executor "${rollback}" "${rollback}/recovered.json"
code=$?
set -e
test "${code}" -eq 1
assert_status "${rollback}/recovered.json" ROLLED_BACK
cmp -s "${rollback}/club.env" "${rollback}/original.env"
# A later successful checker must never re-activate after durable rollback intent.
set +e
TEST_RUNTIME_MODE=success run_executor "${rollback}" "${rollback}/retry.json"
code=$?
set -e
test "${code}" -eq 1
assert_status "${rollback}/retry.json" ALREADY_ROLLED_BACK
cmp -s "${rollback}/club.env" "${rollback}/original.env"

# 4. Non-target drift blocks before mutation.
make_case drift
drift="${work}/drift"
sed -i 's/APP_HOST=localhost/APP_HOST=drift.invalid/' "${drift}/club.env"
chmod 0600 "${drift}/club.env"
set +e
run_executor "${drift}" "${drift}/result.json"
code=$?
set -e
test "${code}" -eq 2
assert_status "${drift}/result.json" BLOCKED
grep -q 'ENV_FINGERPRINT_DRIFT\|ACTIVATION_EXECUTION_NOT_READY' "${drift}/result.json"

# 5. Marker tampering blocks a retry and cannot silently authorize a terminal state.
python3 - "${evidence_dir}/activation-execution-rollback-started.json" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]); data=json.loads(path.read_text()); data['record']['failureReasonCode']='TAMPERED'; path.write_text(json.dumps(data)+'\n'); path.chmod(0o600)
PY
set +e
TEST_RUNTIME_MODE=success run_executor "${rollback}" "${rollback}/tamper.json"
code=$?
set -e
test "${code}" -eq 2
assert_status "${rollback}/tamper.json" BLOCKED
grep -q 'ACTIVATION_EXECUTOR_MARKER_' "${rollback}/tamper.json"

# 6. Implementation boundary: this slice mutates only the bound env and invokes no Docker/Compose.
python3 - "${executor}" <<'PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text()
assert 'os.replace(' in text
for forbidden in ('docker compose','docker volume','compose restart','compose up','subprocess.run(["docker"','subprocess.run([\'docker\''):
    assert forbidden not in text, forbidden
for required in ('ROLLBACK_STARTED','ROLLBACK_VERIFIED','COMPLETED','fcntl.flock','os.fsync','targetEnvFingerprint','currentEnvFingerprint'):
    assert required in text, required
PY

echo 'backup privacy activation executor contract: ok'
