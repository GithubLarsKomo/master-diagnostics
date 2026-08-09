#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
VERIFIER="${SCRIPT_DIR}/verify-restore-rto-drill-report.py"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/verify-club-restore-rto-drill.sh drill-<32 hex>.json" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" || -L "${ENV_FILE}" ]]; then
  echo "Missing or unsafe ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -f "${VERIFIER}" || -L "${VERIFIER}" ]]; then
  echo "Restore RTO drill verifier is missing or unsafe." >&2
  exit 1
fi

report_name="$1"
if [[ ! "${report_name}" =~ ^drill-[0-9a-f]{32}\.json$ ]]; then
  echo "Restore RTO drill report name is invalid." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

report_root="${RESTORE_RTO_DRILL_REPORT_HOST_DIR:-/var/lib/master-diagnostics/restore-rto-drills}"
report_key="${RESTORE_RTO_DRILL_REPORT_KEY_FILE:-/etc/master-diagnostics/restore-rto-drill-report.key}"
report_path="${report_root}/${report_name}"

for pair in "${report_path}|Restore RTO drill report" "${report_key}|Restore RTO drill report key"; do
  path="${pair%%|*}"
  label="${pair#*|}"
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
done

python3 "${VERIFIER}" --report "${report_path}" --key-file "${report_key}"
