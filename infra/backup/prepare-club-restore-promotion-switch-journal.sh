#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
PROMOTION_COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.restore-promotion.yml"
CANDIDATE_HEALTHCHECK="${ROOT_DIR}/infra/backup/check-club-restore-promotion-candidates.sh"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/prepare-club-restore-promotion-switch-journal.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -f "${PROMOTION_COMPOSE_FILE}" || ! -f "${CANDIDATE_HEALTHCHECK}" ]]; then
  echo "Promotion switch journal wiring is incomplete." >&2
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

replay_root="${RESTORE_PRIVACY_REPLAY_HOST_DIR:-/var/lib/master-diagnostics/restore-privacy-replay}"
staging_root="${RESTORE_STAGING_HOST_DIR:-/var/lib/master-diagnostics/restore-staging}"
journal_root="${RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_HOST_DIR:-/var/lib/master-diagnostics/restore-promotion-switch-journal}"
promotion_key="${RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-promotion.key}"
backup_key="${BACKUP_KEY_FILE:-/etc/master-diagnostics/backup.key}"
workspace="${replay_root}/${staging_name}"
switch_dir="${workspace}/promotion/switch"
switch_intent="${switch_dir}/promotion-switch-intent.json"
source_provenance="${staging_root}/${staging_name}/restore-source-provenance.json"

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

require_non_symlink_dir "${workspace}" "Private restore workspace"
require_non_symlink_dir "${switch_dir}" "Restore promotion switch directory"
require_regular_file "${switch_intent}" "Signed restore promotion switch intent"
require_regular_file "${source_provenance}" "Signed restore source provenance"
require_regular_file "${promotion_key}" "Restore promotion key"
require_regular_file "${backup_key}" "Backup encryption/provenance key"

# Recompute the full candidate-set healthcheck immediately before durable evidence creation.
tmp_dir="$(mktemp -d)"
chmod 0700 "${tmp_dir}"
cleanup() {
  rm -rf -- "${tmp_dir}"
}
trap cleanup EXIT

set +e
bash "${CANDIDATE_HEALTHCHECK}" "${staging_name}" \
  >"${tmp_dir}/healthcheck.raw" \
  2>"${tmp_dir}/healthcheck.err"
healthcheck_code=$?
set -e
cat "${tmp_dir}/healthcheck.err" >&2
if [[ ${healthcheck_code} -ne 0 ]]; then
  cat "${tmp_dir}/healthcheck.raw" >&2
  echo "Switch journal preparation requires a fresh healthy candidate set." >&2
  exit "${healthcheck_code}"
fi

candidate_set_id="$(python3 - "${tmp_dir}/healthcheck.raw" "${tmp_dir}/candidate-healthcheck.json" <<'PY'
import json
import re
import sys
from pathlib import Path

raw_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
lines = [line.strip() for line in raw_path.read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit('Candidate-set healthcheck produced no output')
try:
    report = json.loads(lines[-1])
except json.JSONDecodeError as exc:
    raise SystemExit('Final candidate-set healthcheck output is not valid JSON') from exc
if report.get('mode') != 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_HEALTHCHECK':
    raise SystemExit('Candidate-set healthcheck mode is invalid')
if report.get('status') != 'CANDIDATE_SET_HEALTHY':
    raise SystemExit('Candidate-set is not healthy')
if report.get('healthcheckVersion') != 1 or report.get('evidenceRecomputed') is not True:
    raise SystemExit('Candidate-set healthcheck is not a fresh v1 report')
if report.get('candidateMutationAllowed') is not False:
    raise SystemExit('Candidate-set healthcheck unexpectedly authorizes candidate mutation')
if report.get('productionMutationAllowed') is not False or report.get('promotionExecuted') is not False:
    raise SystemExit('Candidate-set healthcheck crossed the production mutation boundary')
for key in ('planFingerprint', 'activeVolumeSetFingerprint', 'candidateSetFingerprint'):
    value = report.get(key)
    if not isinstance(value, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise SystemExit(f'Candidate-set healthcheck {key} is invalid')
candidate_set_id = report.get('candidateSetId')
if not isinstance(candidate_set_id, str) or not re.fullmatch(r'restore-[0-9a-f]{20}', candidate_set_id):
    raise SystemExit('Candidate-set healthcheck candidateSetId is invalid')
if not isinstance(report.get('candidates'), list) or len(report['candidates']) != 4:
    raise SystemExit('Candidate-set healthcheck must contain exactly four candidates')
out_path.write_text(json.dumps(report, sort_keys=True, separators=(',', ':')) + '\n')
print(candidate_set_id)
PY
)"
chmod 0600 "${tmp_dir}/candidate-healthcheck.json"

if [[ -e "${journal_root}" && ( ! -d "${journal_root}" || -L "${journal_root}" ) ]]; then
  echo "Restore promotion switch journal root is unsafe: ${journal_root}" >&2
  exit 1
fi
mkdir -p -- "${journal_root}"
chmod 0700 "${journal_root}"
journal_dir="${journal_root}/${candidate_set_id}"
if [[ -e "${journal_dir}" && ( ! -d "${journal_dir}" || -L "${journal_dir}" ) ]]; then
  echo "Restore promotion switch journal directory is unsafe: ${journal_dir}" >&2
  exit 1
fi
mkdir -p -- "${journal_dir}"
chmod 0700 "${journal_dir}"

export RESTORE_STAGING_NAME="${staging_name}"
export RESTORE_PRIVATE_PROMOTION_CANDIDATE_SET_ID="${candidate_set_id}"
compose=(
  docker compose
  --env-file "${ENV_FILE}"
  -f "${ROOT_DIR}/infra/docker-compose.club.yml"
  -f "${PROMOTION_COMPOSE_FILE}"
)

# Bind the verified encrypted-backup provenance to this exact authenticated switch intent before
# the PENDING switch journal exists. Both artifacts live in the same durable candidate-set directory.
"${compose[@]}" --profile backup build backup-restore-promotion-source-provenance-bind >&2
"${compose[@]}" --profile backup run --rm --no-deps \
  -v "${source_provenance}:/restore-source-provenance.json:ro" \
  -v "${switch_intent}:/promotion-switch-intent.json:ro" \
  backup-restore-promotion-source-provenance-bind >&2
require_regular_file "${journal_dir}/promotion-source-provenance-binding.json" "Durable promotion source-provenance binding"

"${compose[@]}" --profile backup build backup-restore-promotion-switch-journal >&2
"${compose[@]}" --profile backup run --rm --no-deps \
  -v "${tmp_dir}/candidate-healthcheck.json:/candidate-healthcheck.json:ro" \
  -v "${switch_intent}:/promotion-switch-intent.json:ro" \
  backup-restore-promotion-switch-journal
