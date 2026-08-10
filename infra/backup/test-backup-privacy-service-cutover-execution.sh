#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture=/tmp/backup-privacy-activation-executor
success="${fixture}/success"
live_root="${fixture}/service-live-baseline"
tool="${SCRIPT_DIR}/backup-privacy-service-cutover-execution.py"
key="${fixture}/key"

# Build authentic #231 -> #234 -> #237 pre-mutation evidence.
bash "${SCRIPT_DIR}/test-backup-privacy-service-live-baseline.sh" >/dev/null
cutover_plan="$(cat "${success}/cutover-v2-plan-path")"
baseline="$(cat "${live_root}/baseline-path")"
pre="${live_root}/inspect/pre"

root="${fixture}/service-cutover-execution"
rm -rf -- "${root}"
mkdir -p "${root}/inspect/target" "${root}/inspect/partial" "${root}/inspect/rollback" "${root}/success" "${root}/rollback" "${root}/drift"
chmod 0700 "${root}" "${root}/inspect" "${root}/inspect/target" "${root}/inspect/partial" "${root}/inspect/rollback" "${root}/success" "${root}/rollback" "${root}/drift"

python3 - "${pre}" "${root}/inspect" <<'PY'
import json,sys
from copy import deepcopy
from pathlib import Path
pre=Path(sys.argv[1]); out=Path(sys.argv[2])
target_env=[
 'PRIVACY_BACKUP_STATE=ENABLED',
 'PRIVACY_BACKUP_POLICY_VERSION=1.0.0',
 'PRIVACY_BACKUP_ENCRYPTED_AT_REST=true',
 'PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true',
 'PRIVACY_BACKUP_RESTORE_RECONCILIATION=true',
]
new_ids={'app':'8'*64,'export-cleanup':'9'*64,'retention-scan':'a'*64}
rollback_ids={'app':'b'*64,'export-cleanup':'c'*64,'retention-scan':'d'*64}
services=('app','export-cleanup','retention-scan','libsql','caddy')
base={s:json.loads((pre/f'{s}.json').read_text()) for s in services}

def write(folder,data):
    d=out/folder; d.mkdir(exist_ok=True)
    for s,v in data.items(): (d/f'{s}.json').write_text(json.dumps(v)+'\n')

target=deepcopy(base)
for s in new_ids:
    target[s][0]['Id']=new_ids[s]
    target[s][0]['Config']['Env']=target_env
write('target',target)
partial=deepcopy(base)
partial['app'][0]['Id']=new_ids['app']; partial['app'][0]['Config']['Env']=target_env
write('partial',partial)
rollback=deepcopy(base)
for s in rollback_ids:
    rollback[s][0]['Id']=rollback_ids[s]
    rollback[s][0]['Config']['Env']=['PRIVACY_BACKUP_STATE=DISABLED']
write('rollback',rollback)
PY

inspect_args() {
  local dir="$1"
  printf '%s\n' \
    --app-inspect "${dir}/app.json" \
    --export-inspect "${dir}/export-cleanup.json" \
    --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" \
    --caddy-inspect "${dir}/caddy.json"
}

run_prepare() {
  local execution_root="$1" out="$2"
  python3 "${tool}" prepare --cutover-plan "${cutover_plan}" --baseline "${baseline}" --key-file "${key}" \
    --app-inspect "${pre}/app.json" --export-inspect "${pre}/export-cleanup.json" --retention-inspect "${pre}/retention-scan.json" \
    --libsql-inspect "${pre}/libsql.json" --caddy-inspect "${pre}/caddy.json" \
    --execution-root "${execution_root}" --recorded-at 2026-08-10T00:40:00.000Z >"${out}"
}

run_assess() {
  local journal="$1" dir="$2" out="$3"
  python3 "${tool}" assess --cutover-plan "${cutover_plan}" --baseline "${baseline}" --key-file "${key}" --journal "${journal}" \
    --app-inspect "${dir}/app.json" --export-inspect "${dir}/export-cleanup.json" --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" --caddy-inspect "${dir}/caddy.json" >"${out}"
}

run_event() {
  local journal="$1" dir="$2" phase="$3" out="$4" attestation="${5:-}"
  local extra=()
  if [[ -n "${attestation}" ]]; then extra+=(--attestation "${attestation}"); fi
  python3 "${tool}" event --cutover-plan "${cutover_plan}" --baseline "${baseline}" --key-file "${key}" --journal "${journal}" \
    --app-inspect "${dir}/app.json" --export-inspect "${dir}/export-cleanup.json" --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" --caddy-inspect "${dir}/caddy.json" --phase "${phase}" --recorded-at 2026-08-10T00:41:00.000Z "${extra[@]}" >"${out}"
}

status_is() {
  python3 - "$1" "$2" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']==sys.argv[2], r
PY
}

# Journal is created only while the exact signed baseline is still active.
run_prepare "${root}/success" "${root}/prepared.json"
status_is "${root}/prepared.json" SERVICE_CUTOVER_EXECUTION_READY
journal="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["journalPath"])' "${root}/prepared.json")"
test "$(stat -c '%a' "${journal}")" = 600
test "$(stat -c '%a' "$(dirname "${journal}")")" = 700
run_assess "${journal}" "${pre}" "${root}/ready.json"
status_is "${root}/ready.json" READY_TO_START

# CUTOVER_STARTED is durable before mutation. A partial known recreate converges only toward target.
run_event "${journal}" "${pre}" CUTOVER_STARTED "${root}/started.json"
status_is "${root}/started.json" EVENT_PERSISTED
run_assess "${journal}" "${root}/inspect/partial" "${root}/partial.json"
status_is "${root}/partial.json" READY_TO_RECREATE_TARGET
python3 - "${root}/partial.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['liveState']=='MIXED_KNOWN'; assert r['serviceMutationAllowed'] is True
PY

# Crash after full target recreate, before TARGET_RECREATED event: recover evidence, not mutation.
run_assess "${journal}" "${root}/inspect/target" "${root}/recover-target.json"
status_is "${root}/recover-target.json" RECOVER_TARGET_RECREATED
run_event "${journal}" "${root}/inspect/target" TARGET_RECREATED "${root}/target-event.json"
run_assess "${journal}" "${root}/inspect/target" "${root}/ready-validate.json"
status_is "${root}/ready-validate.json" READY_TO_VALIDATE_LIVE

# Validation evidence must be bound before terminal completion.
printf '{"mode":"CI_LIVE_RUNTIME_ATTESTATION","status":"VERIFIED","backupState":"ENABLED"}\n' >"${root}/live-attestation.json"
chmod 0600 "${root}/live-attestation.json"
run_event "${journal}" "${root}/inspect/target" LIVE_VALIDATED "${root}/validated-event.json" "${root}/live-attestation.json"
run_assess "${journal}" "${root}/inspect/target" "${root}/ready-complete.json"
status_is "${root}/ready-complete.json" READY_TO_COMPLETE
run_event "${journal}" "${root}/inspect/target" COMPLETED "${root}/completed-event.json"
run_assess "${journal}" "${root}/inspect/target" "${root}/completed.json"
status_is "${root}/completed.json" COMPLETED
python3 - "${root}/completed.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['activationExecuted'] is True; assert r['serviceCutoverExecuted'] is True; assert r['liveRuntimeAttested'] is True
PY

# Independent rollback execution: sticky ROLLBACK_STARTED before reverse recreate.
run_prepare "${root}/rollback" "${root}/rollback-prepared.json"
rb_journal="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["journalPath"])' "${root}/rollback-prepared.json")"
run_event "${rb_journal}" "${pre}" CUTOVER_STARTED "${root}/rb-started.json"
# Simulate first target service already recreated, then failure chooses rollback.
run_assess "${rb_journal}" "${root}/inspect/partial" "${root}/rb-partial.json"
status_is "${root}/rb-partial.json" READY_TO_RECREATE_TARGET
run_event "${rb_journal}" "${root}/inspect/partial" ROLLBACK_STARTED "${root}/rollback-started.json"
run_assess "${rb_journal}" "${root}/inspect/partial" "${root}/ready-rb.json"
status_is "${root}/ready-rb.json" READY_TO_RECREATE_ROLLBACK
# Crash after all three services are back on DISABLED but before ROLLBACK_RECREATED event.
run_assess "${rb_journal}" "${root}/inspect/rollback" "${root}/recover-rb.json"
status_is "${root}/recover-rb.json" RECOVER_ROLLBACK_RECREATED
run_event "${rb_journal}" "${root}/inspect/rollback" ROLLBACK_RECREATED "${root}/rb-recreated-event.json"
run_assess "${rb_journal}" "${root}/inspect/rollback" "${root}/ready-rb-verify.json"
status_is "${root}/ready-rb-verify.json" READY_TO_VERIFY_ROLLBACK
printf '{"mode":"CI_LIVE_RUNTIME_ATTESTATION","status":"VERIFIED","backupState":"DISABLED"}\n' >"${root}/rollback-attestation.json"
chmod 0600 "${root}/rollback-attestation.json"
run_event "${rb_journal}" "${root}/inspect/rollback" ROLLBACK_VERIFIED "${root}/rb-verified-event.json" "${root}/rollback-attestation.json"
run_assess "${rb_journal}" "${root}/inspect/rollback" "${root}/rolled-back.json"
status_is "${root}/rolled-back.json" ROLLED_BACK
python3 - "${root}/rolled-back.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['activationExecuted'] is False; assert r['serviceCutoverExecuted'] is False
PY

# Preserved identity and active volume drift always block after CUTOVER_STARTED.
for case in caddy-drift volume-drift; do
  dir="${live_root}/inspect/${case}"
  set +e
  run_assess "${rb_journal}" "${dir}" "${root}/${case}.json"
  code=$?
  set -e
  test "${code}" -ne 0 || grep -q '"status":"BLOCKED"' "${root}/${case}.json"
  grep -q '"status":"BLOCKED"' "${root}/${case}.json"
done

# Event HMAC/fingerprint tampering breaks the chain.
started_path="$(dirname "${journal}")/service-cutover-started.json"
cp "${started_path}" "${started_path}.backup"
python3 - "${started_path}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['recordedAt']='2026-08-10T00:41:01.000Z'; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
run_assess "${journal}" "${root}/inspect/target" "${root}/tampered.json"
code=$?
set -e
test "${code}" -ne 0
grep -q 'SERVICE_CUTOVER_EXECUTION_EVENT_SIGNATURE_MISMATCH' "${root}/tampered.json"
mv "${started_path}.backup" "${started_path}"; chmod 0600 "${started_path}"

# Evidence contains only technical identifiers, no unrelated env secrets.
! grep -R -F 'ci-secret-success' "${root}/success"
! grep -R -F 'BETTER_AUTH_SECRET' "${root}/success"

echo 'backup privacy service cutover execution evidence contract: ok'
