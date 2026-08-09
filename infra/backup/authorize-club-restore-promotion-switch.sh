#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
PROMOTION_COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.restore-promotion.yml"
CANDIDATE_HEALTHCHECK="${ROOT_DIR}/infra/backup/check-club-restore-promotion-candidates.sh"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/authorize-club-restore-promotion-switch.sh restore-<timestamp>-<uuid>" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -f "${PROMOTION_COMPOSE_FILE}" || ! -f "${CANDIDATE_HEALTHCHECK}" ]]; then
  echo "Promotion switch authorization wiring is incomplete." >&2
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
promotion_key="${RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE:-/etc/master-diagnostics/restore-private-promotion.key}"
workspace="${replay_root}/${staging_name}"
promotion_dir="${workspace}/promotion"
switch_dir="${promotion_dir}/switch"

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
require_non_symlink_dir "${promotion_dir}" "Restore promotion directory"
require_regular_file "${promotion_key}" "Restore promotion key"
if [[ -e "${switch_dir}" && ( ! -d "${switch_dir}" || -L "${switch_dir}" ) ]]; then
  echo "Restore promotion switch directory is unsafe: ${switch_dir}" >&2
  exit 1
fi
mkdir -p -- "${switch_dir}"
chmod 0700 "${switch_dir}"

# Recompute the entire candidate-set healthcheck immediately before persisting the switch intent.
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
  echo "Promotion switch authorization requires a fresh healthy candidate set." >&2
  exit "${healthcheck_code}"
fi

# The healthcheck wrapper may emit operational stdout before its final machine-readable JSON line.
# Extract and normalize only the final non-empty line, and reject anything other than #212's contract.
python3 - "${tmp_dir}/healthcheck.raw" "${tmp_dir}/candidate-healthcheck.json" <<'PY'
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
if not isinstance(report.get('candidateSetId'), str) or not re.fullmatch(r'restore-[0-9a-f]{20}', report['candidateSetId']):
    raise SystemExit('Candidate-set healthcheck candidateSetId is invalid')
if not isinstance(report.get('candidates'), list) or len(report['candidates']) != 4:
    raise SystemExit('Candidate-set healthcheck must contain exactly four candidates')
out_path.write_text(json.dumps(report, sort_keys=True, separators=(',', ':')) + '\n')
PY
chmod 0600 "${tmp_dir}/candidate-healthcheck.json"

export RESTORE_STAGING_NAME="${staging_name}"
compose=(
  docker compose
  --env-file "${ENV_FILE}"
  -f "${ROOT_DIR}/infra/docker-compose.club.yml"
  -f "${PROMOTION_COMPOSE_FILE}"
)

"${compose[@]}" --profile backup build backup-restore-promotion-switch-intent >&2
"${compose[@]}" --profile backup run --rm --no-deps \
  -v "${tmp_dir}/candidate-healthcheck.json:/candidate-healthcheck.json:ro" \
  backup-restore-promotion-switch-intent
