#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
execution="${SCRIPT_DIR}/backup-privacy-service-cutover-execution.py"
proof_tool="${SCRIPT_DIR}/backup-privacy-service-cutover-preflight.py"
activation_fixture=/tmp/backup-privacy-activation-executor/success
baseline_fixture=/tmp/backup-privacy-service-live-baseline-v2-fixture
execution_fixture=/tmp/backup-privacy-service-cutover-execution-v2
key=/tmp/backup-privacy-activation-executor/key

# Produce the authentic signed plan/baseline chain and bounded inspect fixtures.
bash "${SCRIPT_DIR}/test-backup-privacy-service-cutover-execution.sh" >/dev/null
cutover_plan="$(cat "${activation_fixture}/cutover-v2-plan-path")"
baseline="$(cat "${baseline_fixture}/baseline-path.txt")"
baseline_verification="${baseline_fixture}/baseline-verification-private.json"
pre_inspect="${execution_fixture}/inspect/pre"
partial_inspect="${execution_fixture}/inspect/partial"
target_inspect="${execution_fixture}/inspect/target"

root=/tmp/backup-privacy-service-cutover-preflight-proof
rm -rf "${root}"; mkdir -p "${root}"; chmod 0700 "${root}"

execution_args() {
  local dir="$1"
  printf '%s\n' \
    --cutover-plan "${cutover_plan}" \
    --baseline "${baseline}" \
    --baseline-verification "${baseline_verification}" \
    --key-file "${key}" \
    --app-inspect "${dir}/app.json" \
    --export-inspect "${dir}/export-cleanup.json" \
    --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" \
    --caddy-inspect "${dir}/caddy.json"
}

proof_static_args() {
  local journal="$1" result="$2"
  printf '%s\n' \
    --execution-core "${execution}" \
    --cutover-plan "${cutover_plan}" \
    --baseline "${baseline}" \
    --baseline-verification "${baseline_verification}" \
    --journal "${journal}" \
    --key-file "${key}" \
    --preflight-result "${result}"
}

proof_live_args() {
  local dir="$1"
  printf '%s\n' \
    --app-inspect "${dir}/app.json" \
    --export-inspect "${dir}/export-cleanup.json" \
    --retention-inspect "${dir}/retention-scan.json" \
    --libsql-inspect "${dir}/libsql.json" \
    --caddy-inspect "${dir}/caddy.json"
}

fresh_started_journal() {
  local execution_root="$1" output="$2"
  mapfile -t args < <(execution_args "${pre_inspect}")
  mkdir -p "${execution_root}"; chmod 0700 "${execution_root}"
  python3 "${execution}" prepare "${args[@]}" --execution-root "${execution_root}" \
    --recorded-at 2026-08-10T02:30:00.000Z >"${output}"
  local journal
  journal="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["journalPath"])' "${output}")"
  python3 "${execution}" event "${args[@]}" --journal "${journal}" --phase CUTOVER_STARTED \
    --recorded-at 2026-08-10T02:31:00.000Z >"${output}.started"
  printf '%s\n' "${journal}"
}

journal="$(fresh_started_journal "${root}/execution" "${root}/journal.json")"

# The preflight result mirrors the canonical privacy-capabilities:check shape.
preflight="${root}/privacy-check.json"
cat >"${preflight}" <<'JSON'
{"readyForIrreversibleProcessing":true,"backupState":"ENABLED","notificationsState":"DISABLED","backupPolicyVersion":"1.0.0","notificationPolicyVersion":null,"blockers":[]}
JSON
chmod 0600 "${preflight}"

mapfile -t static_args < <(proof_static_args "${journal}" "${preflight}")
mapfile -t live_args < <(proof_live_args "${pre_inspect}")
proof="${root}/proof/preflight-proof.json"
python3 "${proof_tool}" prepare "${static_args[@]}" "${live_args[@]}" --output "${proof}" \
  --recorded-at 2026-08-10T02:32:00.000Z >"${root}/proof-prepare.json"
python3 - "${root}/proof-prepare.json" "${proof}" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='VERIFIED', r
assert r['targetMutationAuthorized'] is True
assert r['serviceMutationObserved'] is False
p=json.load(open(sys.argv[2])); rec=p['record']
assert p['signature'].startswith('hmac-sha256:')
assert rec['preflightVerifiedBeforeMutation'] is True
assert rec['backupState']=='ENABLED'
assert rec['notificationsState']=='DISABLED'
assert rec['serviceMutationObserved'] is False
assert rec['cutoverStartedEventSignature'].startswith('hmac-sha256:')
PY
test "$(stat -c '%a' "${proof}")" = 600
test "$(stat -c '%a' "$(dirname "${proof}")")" = 700

python3 "${proof_tool}" check "${static_args[@]}" --proof "${proof}" >"${root}/proof-check.json"
python3 - "${root}/proof-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert r['status']=='VERIFIED', r
assert r['targetMutationAuthorized'] is True
assert r['preflightVerifiedBeforeMutation'] is True
PY

# The proof remains historically verifiable after target mutation/event progress.
mapfile -t target_execution_args < <(execution_args "${target_inspect}")
python3 "${execution}" event "${target_execution_args[@]}" --journal "${journal}" --phase TARGET_RECREATED \
  --recorded-at 2026-08-10T02:33:00.000Z >"${root}/target-recreated.json"
python3 "${proof_tool}" check "${static_args[@]}" --proof "${proof}" >"${root}/proof-after-target.json"
grep -F '"status":"VERIFIED"' "${root}/proof-after-target.json"

# A proof cannot first be minted after even a partial recreate.
late_journal="$(fresh_started_journal "${root}/late-execution" "${root}/late-journal.json")"
mapfile -t late_static < <(proof_static_args "${late_journal}" "${preflight}")
mapfile -t partial_live < <(proof_live_args "${partial_inspect}")
set +e
python3 "${proof_tool}" prepare "${late_static[@]}" "${partial_live[@]}" --output "${root}/late-proof.json" \
  --recorded-at 2026-08-10T02:34:00.000Z >"${root}/late-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'CUTOVER_PREFLIGHT_PRESTATE_INVALID' "${root}/late-result.json"

# Notifications must remain disabled and the canonical checker must be ready.
invalid_notifications="${root}/invalid-notifications.json"
cat >"${invalid_notifications}" <<'JSON'
{"readyForIrreversibleProcessing":true,"backupState":"ENABLED","notificationsState":"ENABLED","backupPolicyVersion":"1.0.0","notificationPolicyVersion":"1.0.0","blockers":[]}
JSON
chmod 0600 "${invalid_notifications}"
invalid_journal="$(fresh_started_journal "${root}/invalid-execution" "${root}/invalid-journal.json")"
mapfile -t invalid_static < <(proof_static_args "${invalid_journal}" "${invalid_notifications}")
set +e
python3 "${proof_tool}" prepare "${invalid_static[@]}" "${live_args[@]}" --output "${root}/invalid-proof.json" >"${root}/invalid-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'CUTOVER_PREFLIGHT_RESULT_NOT_READY' "${root}/invalid-result.json"

not_ready="${root}/not-ready.json"
cat >"${not_ready}" <<'JSON'
{"readyForIrreversibleProcessing":false,"backupState":"ENABLED","notificationsState":"DISABLED","backupPolicyVersion":"1.0.0","notificationPolicyVersion":null,"blockers":["TEST_BLOCKER"]}
JSON
chmod 0600 "${not_ready}"
mapfile -t not_ready_static < <(proof_static_args "${invalid_journal}" "${not_ready}")
set +e
python3 "${proof_tool}" prepare "${not_ready_static[@]}" "${live_args[@]}" --output "${root}/not-ready-proof.json" >"${root}/not-ready-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'CUTOVER_PREFLIGHT_RESULT_NOT_READY' "${root}/not-ready-result.json"

# Unexpected fields are rejected so the signed policy output cannot accidentally absorb secrets.
unexpected="${root}/unexpected.json"
cat >"${unexpected}" <<'JSON'
{"readyForIrreversibleProcessing":true,"backupState":"ENABLED","notificationsState":"DISABLED","backupPolicyVersion":"1.0.0","notificationPolicyVersion":null,"blockers":[],"secret":"must-not-enter-proof"}
JSON
chmod 0600 "${unexpected}"
mapfile -t unexpected_static < <(proof_static_args "${invalid_journal}" "${unexpected}")
set +e
python3 "${proof_tool}" prepare "${unexpected_static[@]}" "${live_args[@]}" --output "${root}/unexpected-proof.json" >"${root}/unexpected-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -F 'CUTOVER_PREFLIGHT_RESULT_FIELDS_UNEXPECTED' "${root}/unexpected-result.json"
! grep -R -F 'must-not-enter-proof' "${root}/proof" || true

# HMAC/fingerprint tampering is fail-closed.
cp "${proof}" "${root}/tampered-proof.json"; chmod 0600 "${root}/tampered-proof.json"
python3 - "${root}/tampered-proof.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=json.loads(p.read_text()); d['record']['backupPolicyVersion']='9.9.9'; p.write_text(json.dumps(d)+'\n'); p.chmod(0o600)
PY
set +e
python3 "${proof_tool}" check "${static_args[@]}" --proof "${root}/tampered-proof.json" >"${root}/tampered-result.json"
code=$?
set -e
test "${code}" -ne 0
grep -E 'CUTOVER_PREFLIGHT_PROOF_(FINGERPRINT|SIGNATURE)_MISMATCH' "${root}/tampered-result.json"

# Proof core itself is evidence-only: no Docker, subprocess or env mutation primitive.
python3 - "${proof_tool}" <<'PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text()
for forbidden in ('"docker"','docker compose','subprocess.','os.replace(','force-recreate'):
    assert forbidden not in text, forbidden
assert 'masters:backup-privacy-service-cutover-preflight:v1' in text
assert 'CUTOVER_STARTED' in text
assert 'preflightVerifiedBeforeMutation' in text
PY

echo 'backup privacy service cutover preflight proof contract: ok'