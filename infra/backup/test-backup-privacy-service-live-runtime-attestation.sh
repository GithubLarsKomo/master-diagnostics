#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tool="${SCRIPT_DIR}/backup-privacy-service-live-runtime-attestation.py"
execution_core="${SCRIPT_DIR}/backup-privacy-service-cutover-execution.py"
activation_fixture=/tmp/backup-privacy-activation-executor/success
baseline_fixture=/tmp/backup-privacy-service-live-baseline-v2-fixture
execution_fixture=/tmp/backup-privacy-service-cutover-execution-v2
key=/tmp/backup-privacy-activation-executor/key

# Build the authentic signed v2 chain and both terminal synthetic runtime paths.
bash "${SCRIPT_DIR}/test-backup-privacy-service-cutover-execution.sh" >/dev/null
cutover_plan="$(cat "${activation_fixture}/cutover-v2-plan-path")"
baseline="$(cat "${baseline_fixture}/baseline-path.txt")"
baseline_verification="${baseline_fixture}/baseline-verification-private.json"
success_journal="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["journalPath"])' "${execution_fixture}/prepared.json")"
rollback_journal="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["journalPath"])' "${execution_fixture}/rollback-prepared.json")"

# #244 classifies only BACKUP_*; the independent runtime attester additionally
# requires notifications to remain explicitly DISABLED after every recreate.
python3 - "${execution_fixture}/inspect/target" "${execution_fixture}/inspect/rollback" <<'PY'
import json,sys
from pathlib import Path
for folder in map(Path, sys.argv[1:]):
    for service in ('app','export-cleanup','retention-scan'):
        path=folder/f'{service}.json'
        data=json.loads(path.read_text())
        env=data[0]['Config']['Env']
        env=[item for item in env if not item.startswith('PRIVACY_NOTIFICATIONS_STATE=')]
        env.append('PRIVACY_NOTIFICATIONS_STATE=DISABLED')
        data[0]['Config']['Env']=env
        path.write_text(json.dumps(data)+'\n')
PY

out=/tmp/backup-privacy-service-live-runtime-attestation
rm -rf "${out}"; mkdir -p "${out}"; chmod 0700 "${out}"

common_args() {
  local journal="$1" dir="$2" state="$3"
  printf '%s\n' \
    --execution-core "${execution_core}" \
    --cutover-plan "${cutover_plan}" \
    --baseline "${baseline}" \
    --baseline-verification "${baseline_verification}" \
    --journal "${journal}" \
    --key-file "${key}" \
    --state "${state}" \
    --app-inspect "${dir}/app.json" \
    --export-inspect "${dir}/export-cleanup.json" \
    --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" \
    --caddy-inspect "${dir}/caddy.json"
}

# Fully completed TARGET state can still be independently re-attested from bounded live evidence.
mapfile -t target_args < <(common_args "${success_journal}" "${execution_fixture}/inspect/target" ENABLED)
target_attestation="${out}/target-live-runtime-attestation.json"
python3 "${tool}" prepare "${target_args[@]}" --output "${target_attestation}" \
  --recorded-at 2026-08-10T02:00:00.000Z >"${out}/target-prepare.json"
test "$(stat -c '%a' "${target_attestation}")" = 600
test "$(stat -c '%a' "${out}")" = 700
python3 - "${target_attestation}" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); rec=r['record']
assert r['status']=='VERIFIED' and r['backupState']=='ENABLED'
assert r['signature'].startswith('hmac-sha256:')
assert rec['liveRuntimeAttestationVersion']==1
assert rec['notificationsState']=='DISABLED'
assert rec['executionAssessmentStatus']=='COMPLETED'
assert rec['liveState']=='TARGET'
assert rec['liveRuntimeAttested'] is True
assert rec['activationExecuted'] is True
assert len(rec['boundedLiveState']['services'])==5
mutable=[s for s in rec['boundedLiveState']['services'] if s['service'] in {'app','export-cleanup','retention-scan'}]
assert all(s['privacyEnvironment']['PRIVACY_NOTIFICATIONS_STATE']=='DISABLED' for s in mutable)
PY
python3 "${tool}" check "${target_args[@]}" --attestation "${target_attestation}" >"${out}/target-check.json"
python3 - "${out}/target-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='VERIFIED'; assert r['backupState']=='ENABLED'; assert r['notificationsState']=='DISABLED'; assert r['liveRuntimeAttested'] is True
PY

# The signed document remains byte-compatible with the #244 event validator: it binds the complete signed-file SHA.
python3 - "${execution_core}" "${target_attestation}" <<'PY'
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('execution', Path(sys.argv[1])); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
digest=m.validate_attestation(Path(sys.argv[2]), 'LIVE_VALIDATED')
assert digest.startswith('sha256:')
PY

# Verified rollback path produces a distinct signed DISABLED attestation.
mapfile -t rollback_args < <(common_args "${rollback_journal}" "${execution_fixture}/inspect/rollback" DISABLED)
rollback_attestation="${out}/rollback-live-runtime-attestation.json"
python3 "${tool}" prepare "${rollback_args[@]}" --output "${rollback_attestation}" \
  --recorded-at 2026-08-10T02:01:00.000Z >"${out}/rollback-prepare.json"
python3 "${tool}" check "${rollback_args[@]}" --attestation "${rollback_attestation}" >"${out}/rollback-check.json"
python3 - "${rollback_attestation}" "${out}/rollback-check.json" <<'PY'
import json,sys
signed=json.load(open(sys.argv[1])); checked=json.load(open(sys.argv[2]))
assert signed['backupState']=='DISABLED'; assert signed['record']['executionAssessmentStatus']=='ROLLED_BACK'
assert signed['record']['notificationsState']=='DISABLED'; assert signed['record']['activationExecuted'] is False
assert checked['status']=='VERIFIED' and checked['backupState']=='DISABLED' and checked['notificationsState']=='DISABLED'
PY
python3 - "${execution_core}" "${rollback_attestation}" <<'PY'
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('execution', Path(sys.argv[1])); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.validate_attestation(Path(sys.argv[2]), 'ROLLBACK_VERIFIED').startswith('sha256:')
PY

# Wrong requested backup state is fail-closed even if all evidence files are otherwise valid.
set +e
mapfile -t wrong_args < <(common_args "${rollback_journal}" "${execution_fixture}/inspect/rollback" ENABLED)
python3 "${tool}" prepare "${wrong_args[@]}" --output "${out}/wrong-state.json" >"${out}/wrong-state-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'LIVE_RUNTIME_ATTESTATION_TARGET_NOT_VERIFIED' "${out}/wrong-state-result.json"

# Notifications drift is independently blocked even though #244's backup-only classifier stays TARGET.
notifications_dir="${out}/notifications-drift"
cp -a "${execution_fixture}/inspect/target" "${notifications_dir}"
python3 - "${notifications_dir}/app.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); env=d[0]['Config']['Env']
d[0]['Config']['Env']=['PRIVACY_NOTIFICATIONS_STATE=ENABLED' if x.startswith('PRIVACY_NOTIFICATIONS_STATE=') else x for x in env]
p.write_text(json.dumps(d)+'\n')
PY
set +e
mapfile -t notification_args < <(common_args "${success_journal}" "${notifications_dir}" ENABLED)
python3 "${tool}" prepare "${notification_args[@]}" --output "${out}/notifications-drift.json" >"${out}/notifications-drift-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'LIVE_RUNTIME_ATTESTATION_NOTIFICATIONS_NOT_DISABLED' "${out}/notifications-drift-result.json"

# HMAC tampering is detected before a signed attestation can be trusted.
cp "${target_attestation}" "${out}/tampered.json"; chmod 0600 "${out}/tampered.json"
python3 - "${out}/tampered.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['boundedLiveState']['services'][0]['containerId']='f'*64; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${tool}" check "${target_args[@]}" --attestation "${out}/tampered.json" >"${out}/tampered-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -E 'LIVE_RUNTIME_ATTESTATION_(FINGERPRINT|SIGNATURE)_MISMATCH' "${out}/tampered-result.json"

# Evidence is privacy-bounded: only filtered privacy environment reaches the signed record.
! grep -F 'BETTER_AUTH_SECRET' "${target_attestation}"
! grep -F 'DATABASE_AUTH_TOKEN' "${target_attestation}"

# Attester itself is evidence-only and contains no Docker or service-mutation primitive.
python3 - "${tool}" <<'PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text()
for forbidden in ('"docker"','docker compose','subprocess.','os.replace(','force-recreate'):
    assert forbidden not in text, forbidden
assert 'masters:backup-privacy-service-live-runtime-attestation:v1' in text
assert 'PRIVACY_NOTIFICATIONS_STATE' in text
assert 'boundedLiveState' in text
PY

echo 'backup privacy service live runtime attestation contract: ok'