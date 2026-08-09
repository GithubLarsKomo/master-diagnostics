#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

# Reuse the complete signed activation -> TARGET_HANDOFF crash/rollback contract.
bash infra/backup/test-backup-privacy-target-handoff.sh >/dev/null

fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
key="${fixture}/key"
plan="$(cat "${success}/plan-path")"
pending="$(cat "${success}/pending-path")"
evidence_dir="$(dirname "${pending}")"
handoff="${evidence_dir}/activation-target-handoff.json"
cutover_root="${fixture}/service-cutover-v2"
rm -rf -- "${cutover_root}"
mkdir -p "${cutover_root}"
chmod 0700 "${cutover_root}"

# Rebind the success handoff to the canonical production target-config checker.
rm -f -- "${handoff}"
python3 infra/backup/prepare-backup-privacy-target-handoff.py \
  --plan "${plan}" --pending "${pending}" --key-file "${key}" --env-file "${success}/club.env" \
  --recorded-at 2026-08-10T01:00:00.000Z >"${success}/canonical-handoff.json"
python3 infra/backup/check-backup-privacy-target-handoff.py \
  --plan "${plan}" --pending "${pending}" --handoff "${handoff}" --key-file "${key}" --env-file "${success}/club.env" \
  >"${success}/canonical-handoff-check.json"
python3 - "${success}/canonical-handoff-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['status']=='TARGET_HANDOFF_VERIFIED', r
assert r['serviceCutoverPlanningAllowed'] is True
assert r['serviceCutoverExecuted'] is False
assert r['liveRuntimeAttested'] is False
assert r['activationExecuted'] is False
PY

# Legacy env-only completion can no longer authorize v1 planning.
set +e
python3 infra/backup/check-backup-privacy-activation-completion.py \
  --plan-checker infra/backup/check-backup-privacy-activation-plan.py \
  --evidence-checker infra/backup/backup-privacy-activation-execution.py \
  --plan "${plan}" --pending "${pending}" --completion "${evidence_dir}/activation-execution-completed.json" \
  --key-file "${key}" --env-file "${success}/club.env" >"${success}/legacy-completion-blocked.json"
legacy_code=$?
set -e
test "${legacy_code}" -ne 0
grep -F 'LIVE_RUNTIME_COMPLETION_REQUIRED' "${success}/legacy-completion-blocked.json"

python3 infra/backup/prepare-backup-privacy-service-cutover-plan-v2.py \
  --v1-planner-module "${ROOT_DIR}/infra/backup/prepare-backup-privacy-service-cutover-plan.py" \
  --handoff-checker "${ROOT_DIR}/infra/backup/check-backup-privacy-target-handoff.py" \
  --activation-plan "${plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${success}/club.env" \
  --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" --output-root "${cutover_root}" \
  >"${success}/cutover-v2-output.json"
cutover_plan="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["planPath"])' "${success}/cutover-v2-output.json")"

python3 infra/backup/check-backup-privacy-service-cutover-plan-v2.py --plan "${cutover_plan}" --key-file "${key}" >"${success}/cutover-v2-check.json"
python3 - "${success}/cutover-v2-output.json" "${success}/cutover-v2-check.json" "${cutover_plan}" <<'PY'
import json,sys
from pathlib import Path
prepared=json.load(open(sys.argv[1])); checked=json.load(open(sys.argv[2])); plan=json.load(open(sys.argv[3]))['record']
assert prepared['status']=='SERVICE_CUTOVER_PLAN_READY', prepared
assert prepared['liveBaselineRequiredBeforeMutation'] is True
assert prepared['serviceCutoverExecuted'] is False
assert prepared['liveRuntimeAttested'] is False
assert prepared['activationExecuted'] is False
assert checked['status']=='SERVICE_CUTOVER_PLAN_VERIFIED', checked
assert checked['serviceCutoverExecutionAllowed'] is True
assert checked['liveBaselineRequiredBeforeMutation'] is True
assert plan['serviceCutoverPlanVersion']==2
assert plan['targetHandoffRequiredBeforePlanning'] is True
assert plan['targetHandoffIsNonterminal'] is True
assert plan['liveRuntimeCompletionRequiredAfterCutover'] is True
assert plan['recreateServices']==['app','export-cleanup','retention-scan']
assert plan['preserveServices']==['libsql','caddy']
assert plan['activationExecuted'] is False
assert Path(sys.argv[3]).stat().st_mode & 0o777 == 0o600
PY

# Deterministic plan retry.
python3 infra/backup/prepare-backup-privacy-service-cutover-plan-v2.py \
  --v1-planner-module "${ROOT_DIR}/infra/backup/prepare-backup-privacy-service-cutover-plan.py" \
  --handoff-checker "${ROOT_DIR}/infra/backup/check-backup-privacy-target-handoff.py" \
  --activation-plan "${plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${success}/club.env" \
  --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" --output-root "${cutover_root}" \
  >"${success}/cutover-v2-retry.json"
python3 - "${success}/cutover-v2-retry.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['planCreated'] is False and r['planReused'] is True, r
PY

# Handoff tampering blocks v2 planning before any plan mutation.
cp "${handoff}" "${handoff}.backup"
python3 - "${handoff}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['activationExecuted']=True; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 infra/backup/prepare-backup-privacy-service-cutover-plan-v2.py \
  --v1-planner-module "${ROOT_DIR}/infra/backup/prepare-backup-privacy-service-cutover-plan.py" \
  --handoff-checker "${ROOT_DIR}/infra/backup/check-backup-privacy-target-handoff.py" \
  --activation-plan "${plan}" --pending "${pending}" --handoff "${handoff}" \
  --key-file "${key}" --env-file "${success}/club.env" \
  --compose-file "${ROOT_DIR}/infra/docker-compose.club.yml" --output-root "${cutover_root}" \
  >"${success}/cutover-v2-tamper.json"
tamper_code=$?
set -e
test "${tamper_code}" -ne 0
grep -F 'TARGET_HANDOFF_NOT_VERIFIED' "${success}/cutover-v2-tamper.json"
mv "${handoff}.backup" "${handoff}"
chmod 0600 "${handoff}"

# Plan HMAC/fingerprint tampering blocks the independent checker.
cp "${cutover_plan}" "${cutover_plan}.backup"
python3 - "${cutover_plan}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['activationExecuted']=True; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 infra/backup/check-backup-privacy-service-cutover-plan-v2.py --plan "${cutover_plan}" --key-file "${key}" >"${success}/cutover-v2-plan-tamper.json"
plan_tamper_code=$?
set -e
test "${plan_tamper_code}" -ne 0
mv "${cutover_plan}.backup" "${cutover_plan}"
chmod 0600 "${cutover_plan}"

# Read-only boundary and release gates.
python3 - <<'PY'
from pathlib import Path
text='\n'.join(Path(p).read_text() for p in (
    'infra/backup/prepare-backup-privacy-service-cutover-plan-v2.py',
    'infra/backup/check-backup-privacy-service-cutover-plan-v2.py',
))
for forbidden in ('docker inspect','docker ps','docker run','docker restart','docker volume','os.replace('):
    assert forbidden not in text, forbidden
assert 'liveBaselineRequiredBeforeMutation' in text
assert 'liveRuntimeCompletionRequiredAfterCutover' in text
PY
grep -F 'PRIVACY_BACKUP_STATE=DISABLED' .env.example
grep -F -- '- [ ] Restore-Drill und RTO-Test' TASKS.md
grep -F -- '- [ ] Backup und Restore praktisch getestet wurden' TASKS.md

echo 'backup privacy service cutover plan v2 contract: ok'
