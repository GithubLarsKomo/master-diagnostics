#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
key="${fixture}/key"
completion_checker="${SCRIPT_DIR}/check-backup-privacy-activation-completion.py"
prepare="${SCRIPT_DIR}/prepare-backup-privacy-service-cutover-plan.py"
check="${SCRIPT_DIR}/check-backup-privacy-service-cutover-plan.py"
plan_checker="${SCRIPT_DIR}/check-backup-privacy-activation-plan.py"
evidence_checker="${SCRIPT_DIR}/backup-privacy-activation-execution.py"

# Reuse the full signed #220 -> #226 synthetic chain and its successful activation.
bash "${SCRIPT_DIR}/test-backup-privacy-activation-executor.sh" >/dev/null
activation_plan="$(cat "${success}/plan-path")"
pending="$(cat "${success}/pending-path")"
completion="$(dirname "${pending}")/activation-execution-completed.json"
env_file="${success}/club.env"

python3 "${completion_checker}" \
  --plan-checker "${plan_checker}" --evidence-checker "${evidence_checker}" \
  --plan "${activation_plan}" --pending "${pending}" --completion "${completion}" \
  --key-file "${key}" --env-file "${env_file}" >"${success}/completion-check.json"
python3 - "${success}/completion-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='ACTIVATION_COMPLETION_VERIFIED'; assert r['serviceCutoverPlanningAllowed'] is True
PY

# Compose's service-level env_file is ../.env. Mirror the already-bound synthetic target
# solely for read-only compose rendering in this CI workspace.
cleanup() { rm -f -- "${ROOT_DIR}/.env"; }
trap cleanup EXIT
cp "${env_file}" "${ROOT_DIR}/.env"
chmod 0600 "${ROOT_DIR}/.env"
cutover_root="${fixture}/cutover-plans"
mkdir -p "${cutover_root}"; chmod 0700 "${cutover_root}"

python3 "${prepare}" \
  --completion-checker "${completion_checker}" --plan-checker "${plan_checker}" \
  --evidence-checker "${evidence_checker}" --activation-plan "${activation_plan}" \
  --pending "${pending}" --completion "${completion}" --key-file "${key}" \
  --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --output-root "${cutover_root}" >"${success}/cutover-output.json"
python3 - "${success}/cutover-output.json" "${success}/cutover-plan-path" <<'PY'
import json,sys
from pathlib import Path
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_CUTOVER_PLAN_READY'; assert r['planCreated'] is True; assert r['serviceCutoverExecuted'] is False
Path(sys.argv[2]).write_text(r['planPath'])
PY
cutover_plan="$(cat "${success}/cutover-plan-path")"
test "$(stat -c '%a' "${cutover_plan}")" = 600

python3 "${check}" \
  --completion-checker "${completion_checker}" --plan-checker "${plan_checker}" \
  --evidence-checker "${evidence_checker}" --activation-plan "${activation_plan}" \
  --pending "${pending}" --completion "${completion}" --key-file "${key}" \
  --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --cutover-plan "${cutover_plan}" >"${success}/cutover-check.json"
python3 - "${success}/cutover-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_CUTOVER_PLAN_VERIFIED'; assert r['serviceCutoverExecutionAllowed'] is True; assert r['serviceCutoverExecuted'] is False
PY

# Deterministic retry must reuse the identical plan.
python3 "${prepare}" \
  --completion-checker "${completion_checker}" --plan-checker "${plan_checker}" \
  --evidence-checker "${evidence_checker}" --activation-plan "${activation_plan}" \
  --pending "${pending}" --completion "${completion}" --key-file "${key}" \
  --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --output-root "${cutover_root}" >"${success}/cutover-retry.json"
python3 - "${success}/cutover-retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='SERVICE_CUTOVER_PLAN_READY'; assert r['planCreated'] is False and r['planReused'] is True
PY

# Completion tampering must block before planning.
cp "${completion}" "${success}/tampered-completion.json"; chmod 0600 "${success}/tampered-completion.json"
python3 - "${success}/tampered-completion.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['runtimeAttestationSha256']='sha256:'+'f'*64; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${completion_checker}" \
  --plan-checker "${plan_checker}" --evidence-checker "${evidence_checker}" \
  --plan "${activation_plan}" --pending "${pending}" --completion "${success}/tampered-completion.json" \
  --key-file "${key}" --env-file "${env_file}" >"${success}/tampered-completion-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'BLOCKED' "${success}/tampered-completion-result.json"

# A compose-file byte change is drift even when it is only a comment and the render stays equivalent.
cp "${ROOT_DIR}/infra/docker-compose.club.yml" "${success}/compose-copy.yml"; chmod 0600 "${success}/compose-copy.yml"
# The copied compose resolves ../.env to the fixture root.
cp "${env_file}" "${fixture}/.env"; chmod 0600 "${fixture}/.env"
second_root="${fixture}/cutover-copy"; mkdir -p "${second_root}"; chmod 0700 "${second_root}"
python3 "${prepare}" \
  --completion-checker "${completion_checker}" --plan-checker "${plan_checker}" \
  --evidence-checker "${evidence_checker}" --activation-plan "${activation_plan}" \
  --pending "${pending}" --completion "${completion}" --key-file "${key}" \
  --env-file "${env_file}" --compose-file "${success}/compose-copy.yml" \
  --output-root "${second_root}" >"${success}/copy-plan-output.json"
copy_plan="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["planPath"])' "${success}/copy-plan-output.json")"
printf '\n# post-plan drift\n' >>"${success}/compose-copy.yml"
chmod 0600 "${success}/compose-copy.yml"
set +e
python3 "${check}" \
  --completion-checker "${completion_checker}" --plan-checker "${plan_checker}" \
  --evidence-checker "${evidence_checker}" --activation-plan "${activation_plan}" \
  --pending "${pending}" --completion "${completion}" --key-file "${key}" \
  --env-file "${env_file}" --compose-file "${success}/compose-copy.yml" \
  --cutover-plan "${copy_plan}" >"${success}/compose-drift.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_CUTOVER_ARTIFACT_DRIFT' "${success}/compose-drift.json"

# Plan HMAC/fingerprint tampering must block.
cp "${cutover_plan}" "${success}/tampered-cutover-plan.json"; chmod 0600 "${success}/tampered-cutover-plan.json"
python3 - "${success}/tampered-cutover-plan.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['recreateServices']=['app']; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${check}" \
  --completion-checker "${completion_checker}" --plan-checker "${plan_checker}" \
  --evidence-checker "${evidence_checker}" --activation-plan "${activation_plan}" \
  --pending "${pending}" --completion "${completion}" --key-file "${key}" \
  --env-file "${env_file}" --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" \
  --cutover-plan "${success}/tampered-cutover-plan.json" >"${success}/tampered-plan-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'BLOCKED' "${success}/tampered-plan-result.json"

# This planning slice may render Compose but must not mutate Docker state.
python3 - "${prepare}" "${check}" <<'PY'
from pathlib import Path
import sys
text='\n'.join(Path(p).read_text() for p in sys.argv[1:])
assert '"config", "--format", "json"' in text
for forbidden in ('"up"','"run"','"restart"','"stop"','"down"','docker volume','os.replace('):
    assert forbidden not in text, forbidden
PY

echo 'backup privacy service cutover plan contract: ok'
