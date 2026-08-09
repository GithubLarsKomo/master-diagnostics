#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
key="${fixture}/key"
handoff_checker="${SCRIPT_DIR}/check-backup-privacy-target-handoff.py"
target_checker="${fixture}/target-config-checker.py"
prepare="${SCRIPT_DIR}/prepare-backup-privacy-service-cutover-plan-v2.py"
check="${SCRIPT_DIR}/check-backup-privacy-service-cutover-plan-v2.py"

# Produce the authentic nonterminal TARGET_HANDOFF_VERIFIED chain from #231.
bash "${SCRIPT_DIR}/test-backup-privacy-target-handoff.sh" >/dev/null
activation_plan="$(cat "${success}/plan-path")"
pending="$(cat "${success}/pending-path")"
handoff="$(dirname "${pending}")/activation-target-handoff.json"
env_file="${success}/club.env"
test -f "${handoff}"
test -f "${target_checker}"

# Compose service-level env_file is ../.env. Mirror only the synthetic target fixture.
cleanup() { rm -f -- "${ROOT_DIR}/.env"; }
trap cleanup EXIT
cp "${env_file}" "${ROOT_DIR}/.env"
chmod 0600 "${ROOT_DIR}/.env"
cutover_root="${fixture}/cutover-plans-v2"
mkdir -p "${cutover_root}"; chmod 0700 "${cutover_root}"

python3 "${prepare}" \
  --handoff-checker "${handoff_checker}" --target-config-checker "${target_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --output-root "${cutover_root}" >"${success}/cutover-v2-output.json"
python3 - "${success}/cutover-v2-output.json" "${success}/cutover-v2-plan-path" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1]))
assert r['status']=='SERVICE_CUTOVER_PLAN_READY'
assert r['serviceCutoverPlanVersion']==2
assert r['authorizationSource']=='TARGET_HANDOFF_VERIFIED'
assert r['liveBaselineRequiredBeforeMutation'] is True
assert r['serviceCutoverExecuted'] is False
assert r['liveRuntimeAttested'] is False
assert r['activationExecuted'] is False
Path(sys.argv[2]).write_text(r['planPath'])
PY
cutover_plan="$(cat "${success}/cutover-v2-plan-path")"
test "$(stat -c '%a' "${cutover_plan}")" = 600

python3 "${check}" \
  --handoff-checker "${handoff_checker}" --target-config-checker "${target_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --cutover-plan "${cutover_plan}" >"${success}/cutover-v2-check.json"
python3 - "${success}/cutover-v2-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['status']=='SERVICE_CUTOVER_PLAN_VERIFIED'
assert r['serviceCutoverPlanVersion']==2
assert r['authorizationSource']=='TARGET_HANDOFF_VERIFIED'
assert r['serviceCutoverExecutionAllowed'] is True
assert r['liveBaselineRequiredBeforeMutation'] is True
assert r['serviceCutoverExecuted'] is False
assert r['activationExecuted'] is False
PY

# Deterministic retry reuses identical plan.
python3 "${prepare}" \
  --handoff-checker "${handoff_checker}" --target-config-checker "${target_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --output-root "${cutover_root}" >"${success}/cutover-v2-retry.json"
python3 - "${success}/cutover-v2-retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['planCreated'] is False and r['planReused'] is True
PY

# Handoff tampering blocks planning before a plan can be trusted.
cp "${handoff}" "${handoff}.backup"
python3 - "${handoff}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['serviceCutoverExecuted']=True; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${prepare}" \
  --handoff-checker "${handoff_checker}" --target-config-checker "${target_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --output-root "${fixture}/cutover-v2-tampered" >"${success}/cutover-v2-handoff-tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'TARGET_HANDOFF_NOT_VERIFIED' "${success}/cutover-v2-handoff-tamper.json"
mv "${handoff}.backup" "${handoff}"; chmod 0600 "${handoff}"

# Compose-file byte drift after planning invalidates verification even when target env is unchanged.
cp "${ROOT_DIR}/infra/docker-compose.club.yml" "${success}/compose-v2-copy.yml"; chmod 0600 "${success}/compose-v2-copy.yml"
cp "${env_file}" "${fixture}/.env"; chmod 0600 "${fixture}/.env"
copy_root="${fixture}/cutover-v2-copy"; mkdir -p "${copy_root}"; chmod 0700 "${copy_root}"
python3 "${prepare}" \
  --handoff-checker "${handoff_checker}" --target-config-checker "${target_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${success}/compose-v2-copy.yml" \
  --output-root "${copy_root}" >"${success}/cutover-v2-copy-output.json"
copy_plan="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["planPath"])' "${success}/cutover-v2-copy-output.json")"
printf '\n# post-plan v2 drift\n' >>"${success}/compose-v2-copy.yml"; chmod 0600 "${success}/compose-v2-copy.yml"
set +e
python3 "${check}" \
  --handoff-checker "${handoff_checker}" --target-config-checker "${target_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${success}/compose-v2-copy.yml" \
  --cutover-plan "${copy_plan}" >"${success}/cutover-v2-compose-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_CUTOVER_ARTIFACT_DRIFT' "${success}/cutover-v2-compose-drift.json"

# Plan HMAC/fingerprint and version tampering both fail closed.
cp "${cutover_plan}" "${success}/tampered-cutover-v2.json"; chmod 0600 "${success}/tampered-cutover-v2.json"
python3 - "${success}/tampered-cutover-v2.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['serviceCutoverPlanVersion']=1; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${check}" \
  --handoff-checker "${handoff_checker}" --target-config-checker "${target_checker}" \
  --activation-plan "${activation_plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --cutover-plan "${success}/tampered-cutover-v2.json" >"${success}/cutover-v2-plan-tamper.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_CUTOVER_PLAN_VERSION_INVALID' "${success}/cutover-v2-plan-tamper.json"

# v2 is read-only: Compose may only be rendered, never mutated.
python3 - "${prepare}" "${check}" <<'PY'
from pathlib import Path
import sys
text='\n'.join(Path(p).read_text() for p in sys.argv[1:])
assert '"config", "--format", "json"' in text
assert 'TARGET_HANDOFF_VERIFIED' in text
assert 'liveBaselineRequiredBeforeMutation' in text
for forbidden in ('"up"','"run"','"restart"','"stop"','"down"','docker volume','os.replace('):
    assert forbidden not in text, forbidden
PY

echo 'backup privacy service cutover plan v2 contract: ok'
