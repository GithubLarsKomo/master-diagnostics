#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture=/tmp/backup-privacy-activation-executor
key="${fixture}/key"
legacy="${SCRIPT_DIR}/execute-backup-privacy-activation.py"
prepare="${SCRIPT_DIR}/prepare-backup-privacy-target-handoff.py"
check="${SCRIPT_DIR}/check-backup-privacy-target-handoff.py"
plan_checker="${SCRIPT_DIR}/check-backup-privacy-activation-plan.py"
evidence_checker="${SCRIPT_DIR}/backup-privacy-activation-execution.py"
planner="${SCRIPT_DIR}/prepare-backup-privacy-activation-plan.py"
rollback_checker="${fixture}/runtime-checker.py"
target_checker="${fixture}/target-config-checker.py"

# Build the complete signed Drill -> Attestation -> Plan v2 -> PENDING fixtures.
# The legacy synthetic contract also creates terminal markers; individual cases
# below deliberately remove those synthetic terminals before exercising the new path.
bash "${SCRIPT_DIR}/test-backup-privacy-activation-executor.sh" >/dev/null
cat >"${target_checker}" <<'PY'
import json,os,sys
state=os.environ.get('PRIVACY_BACKUP_STATE')
mode=os.environ.get('TEST_TARGET_MODE','success')
good=(
    state == 'ENABLED'
    and os.environ.get('PRIVACY_BACKUP_POLICY_VERSION') == '1.0.0'
    and os.environ.get('PRIVACY_BACKUP_ENCRYPTED_AT_REST') == 'true'
    and os.environ.get('PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED') == 'true'
    and os.environ.get('PRIVACY_BACKUP_RESTORE_RECONCILIATION') == 'true'
    and mode != 'fail-target'
)
result={
    'readyForIrreversibleProcessing':good,
    'backupState':state or 'UNDECLARED',
    'notificationsState':os.environ.get('PRIVACY_NOTIFICATIONS_STATE','UNDECLARED'),
    'backupPolicyVersion':'1.0.0',
    'notificationPolicyVersion':'1.0.0',
    'attestationScope':'TARGET_CONFIGURATION_POLICY_ONLY',
    'liveRuntimeAttested':False,
    'activationExecuted':False,
    'blockers':[] if good else ['SIMULATED_TARGET_CONFIGURATION_FAILURE'],
}
print(json.dumps(result,separators=(',',':')))
raise SystemExit(0 if good else 1)
PY
chmod 0600 "${target_checker}"

run_prepare() {
  local root="$1" out="$2"
  local plan pending
  plan="$(cat "${root}/plan-path")"; pending="$(cat "${root}/pending-path")"
  python3 "${prepare}" \
    --legacy-executor "${legacy}" --plan-checker "${plan_checker}" --evidence-checker "${evidence_checker}" \
    --planner "${planner}" --target-config-checker "${target_checker}" --rollback-runtime-checker "${rollback_checker}" \
    --plan "${plan}" --pending "${pending}" --key-file "${key}" --env-file "${root}/club.env" \
    --recorded-at 2026-08-10T00:10:00.000Z >"${out}"
}

run_check() {
  local root="$1" out="$2"
  local plan pending handoff
  plan="$(cat "${root}/plan-path")"; pending="$(cat "${root}/pending-path")"; handoff="$(dirname "${pending}")/activation-target-handoff.json"
  python3 "${check}" \
    --legacy-executor "${legacy}" --plan-checker "${plan_checker}" --evidence-checker "${evidence_checker}" \
    --target-config-checker "${target_checker}" --plan "${plan}" --pending "${pending}" --handoff "${handoff}" \
    --key-file "${key}" --env-file "${root}/club.env" >"${out}"
}

assert_status() {
  local file="$1" expected="$2"
  python3 - "${file}" "${expected}" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']==sys.argv[2], r
PY
}

# 1. Fresh pre-state: atomically write target, validate configuration only, emit NONTERMINAL handoff.
success="${fixture}/success"
pending="$(cat "${success}/pending-path")"; success_dir="$(dirname "${pending}")"
rm -f "${success_dir}/activation-execution-completed.json"
cp "${success}/original.env" "${success}/club.env"; chmod 0600 "${success}/club.env"
run_prepare "${success}" "${success}/handoff-result.json"
assert_status "${success}/handoff-result.json" TARGET_HANDOFF_READY
grep -Fx 'PRIVACY_BACKUP_STATE=ENABLED' "${success}/club.env"
test -f "${success_dir}/activation-target-handoff.json"
test "$(stat -c '%a' "${success_dir}/activation-target-handoff.json")" = 600
test ! -e "${success_dir}/activation-execution-completed.json"
python3 - "${success}/handoff-result.json" "${success_dir}/activation-target-handoff.json" <<'PY'
import json,sys
result=json.load(open(sys.argv[1])); evidence=json.load(open(sys.argv[2]))['record']
assert result['serviceCutoverPlanningAllowed'] is True
assert result['serviceCutoverExecuted'] is False
assert result['liveRuntimeAttested'] is False
assert result['activationExecuted'] is False
assert evidence['terminal'] is False
assert evidence['activationExecuted'] is False
assert evidence['liveRuntimeAttested'] is False
assert evidence['serviceCutoverExecuted'] is False
assert evidence['phase']=='TARGET_HANDOFF_READY'
PY
run_check "${success}" "${success}/handoff-check.json"
assert_status "${success}/handoff-check.json" TARGET_HANDOFF_VERIFIED

# Canonical productive runtime checker must still reject ENABLED without live-process proof.
set +e
PRIVACY_BACKUP_STATE=ENABLED bash "${SCRIPT_DIR}/check-backup-privacy-runtime.sh" >"${success}/canonical-runtime-enabled.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'LIVE_RUNTIME_ATTESTATION_REQUIRED' "${success}/canonical-runtime-enabled.json"

# Deterministic retry re-attests the target config and reuses the signed handoff.
run_prepare "${success}" "${success}/handoff-retry.json"
assert_status "${success}/handoff-retry.json" ALREADY_TARGET_HANDOFF_READY

# 2. Simulated crash after target replace but before handoff: target bytes are not rewritten.
crash="${fixture}/crash-post-write"
crash_pending="$(cat "${crash}/pending-path")"; crash_dir="$(dirname "${crash_pending}")"
rm -f "${crash_dir}/activation-execution-completed.json"
before="$(sha256sum "${crash}/club.env" | awk '{print $1}')"
run_prepare "${crash}" "${crash}/handoff-result.json"
after="$(sha256sum "${crash}/club.env" | awk '{print $1}')"
test "${before}" = "${after}"
assert_status "${crash}/handoff-result.json" TARGET_HANDOFF_READY
run_check "${crash}" "${crash}/handoff-check.json"
assert_status "${crash}/handoff-check.json" TARGET_HANDOFF_VERIFIED

# 3. Target configuration failure writes sticky rollback intent BEFORE exact byte rollback.
rollback="${fixture}/rollback"
rollback_pending="$(cat "${rollback}/pending-path")"; rollback_dir="$(dirname "${rollback_pending}")"
rm -f "${rollback_dir}/activation-execution-rollback-started.json" "${rollback_dir}/activation-execution-rollback-verified.json"
cmp -s "${rollback}/club.env" "${rollback}/original.env"
set +e
TEST_TARGET_MODE=fail-target run_prepare "${rollback}" "${rollback}/handoff-fail.json"
code=$?
set -e
test "${code}" -eq 1
assert_status "${rollback}/handoff-fail.json" ROLLED_BACK
cmp -s "${rollback}/club.env" "${rollback}/original.env"
test -f "${rollback_dir}/activation-target-handoff-rollback-started.json"
test -f "${rollback_dir}/activation-target-handoff-rollback-verified.json"
test ! -e "${rollback_dir}/activation-target-handoff.json"

# Simulate crash after byte rollback but before terminal rollback evidence. Retry must NOT re-activate.
rm "${rollback_dir}/activation-target-handoff-rollback-verified.json"
set +e
TEST_TARGET_MODE=success run_prepare "${rollback}" "${rollback}/handoff-recover.json"
code=$?
set -e
test "${code}" -eq 1
assert_status "${rollback}/handoff-recover.json" ROLLED_BACK
cmp -s "${rollback}/club.env" "${rollback}/original.env"
set +e
TEST_TARGET_MODE=success run_prepare "${rollback}" "${rollback}/handoff-after-rollback.json"
code=$?
set -e
test "${code}" -eq 1
assert_status "${rollback}/handoff-after-rollback.json" ALREADY_ROLLED_BACK
cmp -s "${rollback}/club.env" "${rollback}/original.env"

# 4. Handoff HMAC/fingerprint tampering blocks independent verification.
cp "${success_dir}/activation-target-handoff.json" "${success_dir}/activation-target-handoff.backup"
python3 - "${success_dir}/activation-target-handoff.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['activationExecuted']=True; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
run_check "${success}" "${success}/handoff-tamper.json"
code=$?
set -e
test "${code}" -ne 0
assert_status "${success}/handoff-tamper.json" BLOCKED
mv "${success_dir}/activation-target-handoff.backup" "${success_dir}/activation-target-handoff.json"
chmod 0600 "${success_dir}/activation-target-handoff.json"

# 5. Legacy pre-live COMPLETED evidence is an explicit conflict, never an alternate authorization path.
printf '{}\n' >"${success_dir}/activation-execution-completed.json"; chmod 0600 "${success_dir}/activation-execution-completed.json"
set +e
run_check "${success}" "${success}/legacy-completion-conflict.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'TARGET_HANDOFF_STATE_CONFLICT' "${success}/legacy-completion-conflict.json"
rm "${success_dir}/activation-execution-completed.json"
run_check "${success}" "${success}/handoff-check-restored.json"
assert_status "${success}/handoff-check-restored.json" TARGET_HANDOFF_VERIFIED

# Implementation boundary: no Docker/Compose and no terminal COMPLETED persistence in the handoff slice.
python3 - "${prepare}" "${check}" "${SCRIPT_DIR}/check-backup-privacy-target-config.py" <<'PY'
from pathlib import Path
import sys
text='\n'.join(Path(p).read_text() for p in sys.argv[1:])
for forbidden in ('docker compose','docker inspect','docker ps','docker run','docker restart'):
    assert forbidden not in text, forbidden
assert '"TARGET_HANDOFF_READY": "activation-target-handoff.json"' in text
assert 'activation-execution-completed.json' in text  # conflict detection only
assert 'persist(paths["TARGET_HANDOFF_READY"]' in text
assert '"activationExecuted": False' in text
assert '"liveRuntimeAttested": False' in text
PY

echo 'backup privacy target handoff contract: ok'
