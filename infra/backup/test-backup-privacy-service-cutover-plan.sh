#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
key="${fixture}/key"
prepare="${SCRIPT_DIR}/prepare-backup-privacy-service-cutover-plan.py"
check="${SCRIPT_DIR}/check-backup-privacy-service-cutover-plan.py"
handoff_checker="${SCRIPT_DIR}/check-backup-privacy-target-handoff.py"
activation_plan_checker="${SCRIPT_DIR}/check-backup-privacy-activation-plan.py"
execution_evidence_checker="${SCRIPT_DIR}/backup-privacy-activation-execution.py"

# Build the complete signed chain through nonterminal TARGET_HANDOFF_READY.
bash "${SCRIPT_DIR}/test-backup-privacy-target-handoff.sh" >/dev/null
activation_plan="$(cat "${success}/plan-path")"
pending="$(cat "${success}/pending-path")"
handoff="$(dirname "${pending}")/activation-target-handoff.json"
env_file="${success}/club.env"
target_config_checker="${fixture}/target-config-checker.py"

test -f "${handoff}"
test ! -e "$(dirname "${pending}")/activation-execution-completed.json"

cleanup() { rm -f -- "${ROOT_DIR}/.env"; }
trap cleanup EXIT
# Compose service-level env_file is ../.env; mirror the same already-signed target
# only for read-only Compose rendering in this CI workspace.
cp "${env_file}" "${ROOT_DIR}/.env"
chmod 0600 "${ROOT_DIR}/.env"

chain_args=(
  --handoff-checker "${handoff_checker}"
  --activation-plan-checker "${activation_plan_checker}"
  --execution-evidence-checker "${execution_evidence_checker}"
  --target-config-checker "${target_config_checker}"
  --activation-plan "${activation_plan}"
  --pending "${pending}"
  --handoff "${handoff}"
  --key-file "${key}"
  --env-file "${env_file}"
  --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml"
)

cutover_root="${fixture}/cutover-plans-v2"
mkdir -p "${cutover_root}"; chmod 0700 "${cutover_root}"
python3 "${prepare}" "${chain_args[@]}" --output-root "${cutover_root}" >"${success}/cutover-v2-output.json"
python3 - "${success}/cutover-v2-output.json" "${success}/cutover-plan-v2-path" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1]))
assert r['status']=='SERVICE_CUTOVER_PLAN_READY', r
assert r['serviceCutoverPlanVersion']==2
assert r['planCreated'] is True and r['planReused'] is False
assert r['liveBaselineRequired'] is True
assert r['serviceCutoverExecutionAllowed'] is False
assert r['serviceCutoverExecuted'] is False
assert r['liveRuntimeAttested'] is False
assert r['activationExecuted'] is False
Path(sys.argv[2]).write_text(r['planPath'])
PY
cutover_plan="$(cat "${success}/cutover-plan-v2-path")"
test "$(stat -c '%a' "${cutover_plan}")" = 600
test "$(stat -c '%a' "${cutover_root}")" = 700

python3 "${check}" "${chain_args[@]}" --cutover-plan "${cutover_plan}" >"${success}/cutover-v2-check.json"
python3 - "${success}/cutover-v2-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['status']=='SERVICE_CUTOVER_PLAN_VERIFIED', r
assert r['serviceCutoverPlanVersion']==2
assert r['liveBaselineRequired'] is True
assert r['serviceCutoverExecutionAllowed'] is False
assert r['serviceCutoverExecuted'] is False
assert r['liveRuntimeAttested'] is False
assert r['activationExecuted'] is False
PY

# The signed plan must bind the nonterminal handoff and must contain no legacy Completion fields.
python3 - "${cutover_plan}" "${handoff}" <<'PY'
import hashlib,json,sys
plan=json.load(open(sys.argv[1]))['record']
handoff_raw=open(sys.argv[2],'rb').read(); handoff=json.loads(handoff_raw)['record']
assert plan['serviceCutoverPlanVersion']==2
assert plan['targetHandoffFingerprint']==handoff['handoffFingerprint']
assert plan['targetHandoffFileSha256']=='sha256:'+hashlib.sha256(handoff_raw).hexdigest()
assert plan['targetConfigAttestationSha256']==handoff['targetConfigAttestationSha256']
assert plan['liveBaselineRequiredBeforeMutation'] is True
assert plan['serviceCutoverExecuted'] is False
assert plan['liveRuntimeAttested'] is False
assert plan['activationExecuted'] is False
for forbidden in ('completionPath','completionFingerprint','completionFileSha256','configurationRuntimeAttestationSha256'):
    assert forbidden not in plan, forbidden
PY

# Deterministic retry reuses the identical v2 plan.
python3 "${prepare}" "${chain_args[@]}" --output-root "${cutover_root}" >"${success}/cutover-v2-retry.json"
python3 - "${success}/cutover-v2-retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_CUTOVER_PLAN_READY'; assert r['planCreated'] is False and r['planReused'] is True
PY

# Handoff tampering blocks planning before Compose mutation could ever exist.
tamper_dir="${fixture}/tampered-handoff"; mkdir -p "${tamper_dir}"; chmod 0700 "${tamper_dir}"
tampered_handoff="${tamper_dir}/activation-target-handoff.json"
cp "${handoff}" "${tampered_handoff}"; chmod 0600 "${tampered_handoff}"
python3 - "${tampered_handoff}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['activationExecuted']=True; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${prepare}" \
  --handoff-checker "${handoff_checker}" --activation-plan-checker "${activation_plan_checker}" \
  --execution-evidence-checker "${execution_evidence_checker}" --target-config-checker "${target_config_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${tampered_handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --output-root "${fixture}/tampered-cutover-output" >"${success}/cutover-handoff-tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'TARGET_HANDOFF_NOT_VERIFIED' "${success}/cutover-handoff-tamper.json"

# A Compose-file byte change is drift even when the rendered model is semantically identical.
cp "${ROOT_DIR}/infra/docker-compose.club.yml" "${success}/compose-v2-copy.yml"; chmod 0600 "${success}/compose-v2-copy.yml"
cp "${env_file}" "${fixture}/.env"; chmod 0600 "${fixture}/.env"
second_root="${fixture}/cutover-v2-copy"; mkdir -p "${second_root}"; chmod 0700 "${second_root}"
copy_args=(
  --handoff-checker "${handoff_checker}"
  --activation-plan-checker "${activation_plan_checker}"
  --execution-evidence-checker "${execution_evidence_checker}"
  --target-config-checker "${target_config_checker}"
  --activation-plan "${activation_plan}"
  --pending "${pending}"
  --handoff "${handoff}"
  --key-file "${key}"
  --env-file "${env_file}"
  --compose-file "${success}/compose-v2-copy.yml"
)
python3 "${prepare}" "${copy_args[@]}" --output-root "${second_root}" >"${success}/cutover-copy-v2-output.json"
copy_plan="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["planPath"])' "${success}/cutover-copy-v2-output.json")"
printf '\n# post-plan byte drift\n' >>"${success}/compose-v2-copy.yml"
chmod 0600 "${success}/compose-v2-copy.yml"
set +e
python3 "${check}" "${copy_args[@]}" --cutover-plan "${copy_plan}" >"${success}/cutover-compose-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'SERVICE_CUTOVER_ARTIFACT_DRIFT' "${success}/cutover-compose-drift.json"

# Plan v1 or HMAC/fingerprint tampering cannot be accepted by the v2 checker.
tampered_plan="${success}/tampered-cutover-v2.json"
cp "${cutover_plan}" "${tampered_plan}"; chmod 0600 "${tampered_plan}"
python3 - "${tampered_plan}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['serviceCutoverPlanVersion']=1; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${check}" "${chain_args[@]}" --cutover-plan "${tampered_plan}" >"${success}/cutover-v1-rejected.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'SERVICE_CUTOVER_PLAN_VERSION_INVALID' "${success}/cutover-v1-rejected.json"

cp "${cutover_plan}" "${tampered_plan}"; chmod 0600 "${tampered_plan}"
python3 - "${tampered_plan}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['recreateServices']=['app']; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${check}" "${chain_args[@]}" --cutover-plan "${tampered_plan}" >"${success}/cutover-plan-tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_CUTOVER_SERVICE_POLICY_INVALID\|SERVICE_CUTOVER_PLAN_FINGERPRINT_MISMATCH' "${success}/cutover-plan-tamper.json"

# This planning slice may render Compose but cannot inspect/mutate live Docker state or write env bytes.
python3 - "${prepare}" "${check}" <<'PY'
from pathlib import Path
import sys
text='\n'.join(Path(p).read_text() for p in sys.argv[1:])
assert '"config", "--format", "json"' in text
for forbidden in ('"up"','"run"','"restart"','"stop"','"down"','"inspect"','"ps"','docker volume','os.replace('):
    assert forbidden not in text, forbidden
for required in ('targetHandoffFingerprint','liveBaselineRequiredBeforeMutation','activationExecuted'):
    assert required in text, required
PY

echo 'backup privacy service cutover plan v2 contract: ok'
