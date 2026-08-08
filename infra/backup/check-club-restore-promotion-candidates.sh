#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
PROMOTION_COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.restore-promotion.yml"
RESOLVER="${ROOT_DIR}/infra/backup/resolve-active-club-volumes.py"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/check-club-restore-promotion-candidates.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -f "${PROMOTION_COMPOSE_FILE}" || ! -f "${RESOLVER}" ]]; then
  echo "Promotion candidate healthcheck wiring is incomplete." >&2
  exit 1
fi

staging_name="$1"
if [[ ! "${staging_name}" =~ ^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Restore staging name is invalid." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

staging_root="${RESTORE_STAGING_HOST_DIR:-/var/lib/master-diagnostics/restore-staging}"
replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
promotion_key="${RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-promotion.key}"
recovery_key="${RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-recovery-intent.key}"
source_root="${staging_root}/${staging_name}"
manifest_path="${source_root}/manifest.json"
workspace="${replay_root}/${staging_name}"
promotion_dir="${workspace}/promotion"
promotion_intent_path="${promotion_dir}/promotion-intent.json"
execution_plan_path="${promotion_dir}/promotion-execution-plan.json"
artifact_manifest_path="${workspace}/artifact-replay-manifest.json"
artifact_result_path="${workspace}/artifact-replay-result.json"
recovery_plan_path="${workspace}/recovery-plan.json"
recovery_execution_dir="${workspace}/recovery-execution"
recovery_intent_path="${recovery_execution_dir}/recovery-execution-pending.json"
recovery_receipt_path="${recovery_execution_dir}/recovery-execution-completed.json"
required_workspace_dirs=(libsql reports tenant-exports data-subject-delivery)

require_regular_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

require_non_symlink_dir() {
  local path="$1"
  local label="$2"
  if [[ ! -d "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

require_regular_file "${manifest_path}" "Restore staging manifest"
require_non_symlink_dir "${workspace}" "Private restore workspace"
for source_name in "${required_workspace_dirs[@]}"; do
  require_non_symlink_dir "${workspace}/${source_name}" "Private restore workspace directory ${source_name}"
done
require_regular_file "${artifact_manifest_path}" "Restore artifact replay manifest"
require_regular_file "${artifact_result_path}" "Restore artifact replay result"
require_regular_file "${promotion_key}" "Restore promotion intent key"
require_non_symlink_dir "${promotion_dir}" "Restore promotion directory"
require_regular_file "${promotion_intent_path}" "Restore promotion intent"
require_regular_file "${execution_plan_path}" "Restore promotion execution plan"

for evidence_path in "${recovery_plan_path}" "${recovery_intent_path}" "${recovery_receipt_path}"; do
  if [[ -e "${evidence_path}" && ( ! -f "${evidence_path}" || -L "${evidence_path}" ) ]]; then
    echo "Restore recovery evidence path is unsafe: ${evidence_path}" >&2
    exit 1
  fi
done
if [[ -e "${recovery_execution_dir}" && ( ! -d "${recovery_execution_dir}" || -L "${recovery_execution_dir}" ) ]]; then
  echo "Restore recovery execution directory is unsafe: ${recovery_execution_dir}" >&2
  exit 1
fi

base_compose=(
  docker compose
  --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
)

resolve_container_id() {
  local service="$1"
  local ids=()
  mapfile -t ids < <("${base_compose[@]}" ps -q "${service}" | awk 'NF')
  if [[ ${#ids[@]} -ne 1 ]]; then
    echo "Expected exactly one running ${service} container, found ${#ids[@]}." >&2
    exit 1
  fi
  printf '%s\n' "${ids[0]}"
}

tmp_dir="$(mktemp -d)"
chmod 0700 "${tmp_dir}"
cleanup_tmp() {
  rm -rf -- "${tmp_dir}"
}
trap cleanup_tmp EXIT

"${base_compose[@]}" config --format json >"${tmp_dir}/compose.json"
app_container_id="$(resolve_container_id app)"
libsql_container_id="$(resolve_container_id libsql)"
docker inspect "${app_container_id}" >"${tmp_dir}/app-inspect.json"
docker inspect "${libsql_container_id}" >"${tmp_dir}/libsql-inspect.json"

resolved_volumes=()
mapfile -t resolved_volumes < <(
  python3 "${RESOLVER}" \
    --compose-json "${tmp_dir}/compose.json" \
    --app-inspect-json "${tmp_dir}/app-inspect.json" \
    --libsql-inspect-json "${tmp_dir}/libsql-inspect.json" \
    --format lines
)
if [[ ${#resolved_volumes[@]} -ne 4 ]]; then
  echo "Active application volume resolver returned an invalid result." >&2
  exit 1
fi
active_libsql_volume="${resolved_volumes[0]}"
active_reports_volume="${resolved_volumes[1]}"
active_tenant_exports_volume="${resolved_volumes[2]}"
active_data_subject_delivery_volume="${resolved_volumes[3]}"

recovery_run_args=()
if [[ -e "${recovery_key}" ]]; then
  require_regular_file "${recovery_key}" "Restore recovery intent key"
  recovery_run_args+=(
    -v "${recovery_key}:/run/secrets/restore-private-recovery-intent.key:ro"
    -e "RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE=/run/secrets/restore-private-recovery-intent.key"
  )
fi

export RESTORE_STAGING_NAME="${staging_name}"
compose=(
  docker compose
  --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
  -f "${PROMOTION_COMPOSE_FILE}"
)
private_db_running=true
cleanup_private_db() {
  if [[ "${private_db_running}" == true ]]; then
    "${compose[@]}" --profile backup rm -sf backup-privacy-replay-db >/dev/null 2>&1 || true
    private_db_running=false
  fi
}
trap 'cleanup_private_db; cleanup_tmp' EXIT

"${compose[@]}" --profile backup build \
  backup-privacy-replay-migrate \
  backup-restore-promotion-plan \
  backup-restore-promotion-candidate-check
"${compose[@]}" --profile backup run --rm backup-privacy-replay-migrate

"${compose[@]}" --profile backup run --rm \
  "${recovery_run_args[@]}" \
  -e "RESTORE_STAGING_MANIFEST=/restore-staging/${staging_name}/manifest.json" \
  -e "RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE=/restore-replay/promotion/promotion-execution-plan.json" \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_LIBSQL_VOLUME=${active_libsql_volume}" \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_REPORTS_VOLUME=${active_reports_volume}" \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_TENANT_EXPORTS_VOLUME=${active_tenant_exports_volume}" \
  -e "RESTORE_PRIVATE_PROMOTION_ACTIVE_DATA_SUBJECT_DELIVERY_VOLUME=${active_data_subject_delivery_volume}" \
  backup-restore-promotion-plan \
  pnpm --silent --filter @masters/db backup:restore-promotion-candidates-preflight \
  >"${tmp_dir}/candidate-set-preflight.json"

# Stop the private DB before hashing its libsql tree so all four source trees are quiescent.
cleanup_private_db

candidate_rows=()
mapfile -t candidate_rows < <(
  python3 - "${tmp_dir}/candidate-set-preflight.json" <<'PY'
import json
import re
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text())
if result.get('mode') != 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_PREFLIGHT':
    raise SystemExit('Candidate-set preflight mode is invalid')
if result.get('status') != 'CANDIDATE_SET_CHECK_READY':
    raise SystemExit('Candidate-set healthcheck was not authorized')
if result.get('evidenceRecomputed') is not True:
    raise SystemExit('Candidate-set preflight did not recompute evidence')
if result.get('candidateMutationAllowed') is not False:
    raise SystemExit('Candidate-set healthcheck must not authorize candidate mutation')
if result.get('productionMutationAllowed') is not False or result.get('promotionExecuted') is not False:
    raise SystemExit('Candidate-set preflight crossed the production mutation boundary')
plan_fingerprint = result.get('planFingerprint')
active_fingerprint = result.get('activeVolumeSetFingerprint')
candidate_set = result.get('candidateSetId')
if not isinstance(plan_fingerprint, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', plan_fingerprint):
    raise SystemExit('Candidate-set plan fingerprint is invalid')
if not isinstance(active_fingerprint, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', active_fingerprint):
    raise SystemExit('Candidate-set active volume fingerprint is invalid')
if not isinstance(candidate_set, str) or not re.fullmatch(r'restore-[0-9a-f]{20}', candidate_set):
    raise SystemExit('Candidate-set ID is invalid')
expected = [
    ('LIBSQL', 'libsql'),
    ('REPORTS', 'reports'),
    ('TENANT_EXPORTS', 'tenant-exports'),
    ('DATA_SUBJECT_DELIVERY', 'data-subject-delivery'),
]
volumes = result.get('volumes')
if not isinstance(volumes, list) or len(volumes) != 4:
    raise SystemExit('Candidate-set volume list is invalid')
active = set()
candidates = set()
for item, (role, subpath) in zip(volumes, expected, strict=True):
    if not isinstance(item, dict) or item.get('role') != role or item.get('restoreWorkspaceSubpath') != subpath:
        raise SystemExit('Candidate-set role order is invalid')
    current = item.get('activeVolumeName')
    rollback = item.get('rollbackVolumeName')
    candidate = item.get('candidateVolumeName')
    for value in (current, rollback, candidate):
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value):
            raise SystemExit('Candidate-set contains an unsafe Docker volume name')
    if rollback != current or candidate == current:
        raise SystemExit('Candidate-set rollback/candidate identity is invalid')
    active.add(current)
    candidates.add(candidate)
    print('\t'.join((role, subpath, current, candidate, plan_fingerprint, active_fingerprint, candidate_set)))
if len(active) != 4 or len(candidates) != 4 or active & candidates:
    raise SystemExit('Candidate-set volume identities are not distinct')
PY
)
if [[ ${#candidate_rows[@]} -ne 4 ]]; then
  echo "Candidate-set preflight did not produce exactly four candidate rows." >&2
  exit 1
fi

verify_candidate_volume() {
  local role="$1"
  local active_volume="$2"
  local candidate_volume="$3"
  local plan_fingerprint="$4"
  local candidate_set="$5"

  if ! docker volume inspect "${candidate_volume}" >"${tmp_dir}/volume-inspect.json" 2>/dev/null; then
    echo "Candidate volume is missing: ${candidate_volume}" >&2
    exit 1
  fi
  python3 - "${tmp_dir}/volume-inspect.json" "${candidate_volume}" "${role}" "${active_volume}" "${plan_fingerprint}" "${candidate_set}" <<'PY'
import json
import sys
from pathlib import Path

record = json.loads(Path(sys.argv[1]).read_text())
if not isinstance(record, list) or len(record) != 1:
    raise SystemExit('Candidate volume inspect result is invalid')
volume = record[0]
if volume.get('Name') != sys.argv[2]:
    raise SystemExit('Candidate volume inspect returned a different name')
if volume.get('Driver') != 'local' or volume.get('Scope') != 'local':
    raise SystemExit('Candidate volume must use the local Docker volume driver/scope')
labels = volume.get('Labels') or {}
expected = {
    'com.master-diagnostics.restore.promotion-candidate': 'true',
    'com.master-diagnostics.restore.plan-fingerprint': sys.argv[5],
    'com.master-diagnostics.restore.candidate-set': sys.argv[6],
    'com.master-diagnostics.restore.role': sys.argv[3],
    'com.master-diagnostics.restore.rollback-volume': sys.argv[4],
}
for key, value in expected.items():
    if labels.get(key) != value:
        raise SystemExit(f'Candidate volume label mismatch: {key}')
PY

  local users=()
  mapfile -t users < <(docker ps -aq --filter "volume=${candidate_volume}" | awk 'NF')
  if [[ ${#users[@]} -ne 0 ]]; then
    echo "Candidate volume is already attached to ${#users[@]} container(s): ${candidate_volume}" >&2
    exit 1
  fi
}

for row in "${candidate_rows[@]}"; do
  IFS=$'\t' read -r role subpath active_volume candidate_volume plan_fingerprint active_fingerprint candidate_set <<<"${row}"
  verify_candidate_volume \
    "${role}" \
    "${active_volume}" \
    "${candidate_volume}" \
    "${plan_fingerprint}" \
    "${candidate_set}"

  RESTORE_STAGING_NAME="${staging_name}" \
  RESTORE_PRIVATE_PROMOTION_CANDIDATE_VOLUME="${candidate_volume}" \
    "${compose[@]}" --profile backup run --rm --no-deps \
      -e "RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE=${role}" \
      backup-restore-promotion-candidate-check \
      >"${tmp_dir}/candidate-${role}.json"
done

python3 - "${tmp_dir}" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
preflight = json.loads(root.joinpath('candidate-set-preflight.json').read_text())
expected = [
    ('LIBSQL', 'libsql'),
    ('REPORTS', 'reports'),
    ('TENANT_EXPORTS', 'tenant-exports'),
    ('DATA_SUBJECT_DELIVERY', 'data-subject-delivery'),
]
volume_by_role = {item['role']: item for item in preflight['volumes']}
candidates = []
for role, subpath in expected:
    result = json.loads(root.joinpath(f'candidate-{role}.json').read_text())
    if result.get('mode') != 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_HEALTHCHECK':
        raise SystemExit(f'Candidate healthcheck mode is invalid for {role}')
    if result.get('status') != 'HEALTHY' or result.get('role') != role or result.get('sourceSubpath') != subpath:
        raise SystemExit(f'Candidate healthcheck is not healthy for {role}')
    if result.get('candidateMutationAllowed') is not False:
        raise SystemExit(f'Candidate healthcheck authorizes mutation for {role}')
    if result.get('productionMutationAllowed') is not False or result.get('promotionExecuted') is not False:
        raise SystemExit(f'Candidate healthcheck crossed the production boundary for {role}')
    source_fp = result.get('sourceFingerprint')
    candidate_fp = result.get('candidateFingerprint')
    if source_fp != candidate_fp or not isinstance(source_fp, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', source_fp):
        raise SystemExit(f'Candidate tree fingerprint mismatch for {role}')
    volume = volume_by_role[role]
    candidates.append({
        'role': role,
        'sourceSubpath': subpath,
        'candidateVolumeName': volume['candidateVolumeName'],
        'rollbackVolumeName': volume['rollbackVolumeName'],
        'sourceFingerprint': source_fp,
        'candidateFingerprint': candidate_fp,
        'fileCount': result['fileCount'],
        'directoryCount': result['directoryCount'],
        'byteCount': result['byteCount'],
    })
body = {
    'healthcheckVersion': 1,
    'planFingerprint': preflight['planFingerprint'],
    'activeVolumeSetFingerprint': preflight['activeVolumeSetFingerprint'],
    'candidateSetId': preflight['candidateSetId'],
    'candidates': candidates,
}
fingerprint = 'sha256:' + hashlib.sha256(
    json.dumps(body, sort_keys=True, separators=(',', ':')).encode()
).hexdigest()
print(json.dumps({
    'mode': 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_HEALTHCHECK',
    'status': 'CANDIDATE_SET_HEALTHY',
    'healthcheckVersion': 1,
    'evidenceRecomputed': True,
    'candidateMutationAllowed': False,
    'productionMutationAllowed': False,
    'promotionExecuted': False,
    'planFingerprint': preflight['planFingerprint'],
    'activeVolumeSetFingerprint': preflight['activeVolumeSetFingerprint'],
    'candidateSetId': preflight['candidateSetId'],
    'candidateSetFingerprint': fingerprint,
    'candidates': candidates,
}, sort_keys=True, separators=(',', ':')))
PY
