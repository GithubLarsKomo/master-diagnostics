#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
CHECKER="${SCRIPT_DIR}/check-backup-privacy-activation-readiness.py"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash infra/backup/check-club-backup-privacy-activation-readiness.sh /absolute/path/to/drill-<id>.json" >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the club deployment first." >&2
  exit 1
fi
if [[ ! -f "${CHECKER}" || -L "${CHECKER}" ]]; then
  echo "Backup privacy activation readiness checker is missing or unsafe." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

report="$1"
report_root="${RESTORE_RTO_DRILL_REPORT_HOST_DIR:-/var/lib/master-diagnostics/restore-rto-drills}"
report_key="${RESTORE_RTO_DRILL_REPORT_KEY_FILE:-/etc/master-diagnostics/restore-rto-drill-report.key}"

if [[ "${report}" != /* ]]; then
  echo "Restore RTO drill report path must be absolute." >&2
  exit 2
fi
if [[ ! -d "${report_root}" || -L "${report_root}" ]]; then
  echo "Restore RTO drill report root is missing or unsafe: ${report_root}" >&2
  exit 1
fi
if [[ ! -f "${report}" || -L "${report}" ]]; then
  echo "Restore RTO drill report is missing or unsafe: ${report}" >&2
  exit 1
fi
if [[ ! -f "${report_key}" || -L "${report_key}" ]]; then
  echo "Restore RTO drill report key is missing or unsafe: ${report_key}" >&2
  exit 1
fi

report_root_real="$(realpath -- "${report_root}")"
report_real="$(realpath -- "${report}")"
case "${report_real}" in
  "${report_root_real}"/*) ;;
  *)
    echo "Restore RTO drill report must be inside ${report_root_real}." >&2
    exit 1
    ;;
esac

exec python3 "${CHECKER}" \
  --report "${report_real}" \
  --key-file "${report_key}"
