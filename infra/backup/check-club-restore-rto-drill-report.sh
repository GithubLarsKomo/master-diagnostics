#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
CHECKER="${SCRIPT_DIR}/check-restore-rto-drill-report.py"

if [[ $# -ne 2 ]]; then
  echo "Usage: bash infra/backup/check-club-restore-rto-drill-report.sh drill-<32hex> masters-backup-<timestamp>-<uuid>.mdbak" >&2
  exit 2
fi

drill_id="$1"
bundle_name="$2"
if [[ ! "${drill_id}" =~ ^drill-[0-9a-f]{32}$ ]]; then
  echo "Restore RTO drill ID is invalid." >&2
  exit 2
fi
if [[ ! "${bundle_name}" =~ ^masters-backup-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdbak$ ]]; then
  echo "Backup file name is invalid." >&2
  exit 2
fi

require_regular_file() {
  local path="$1" label="$2"
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

require_regular_file "${ENV_FILE}" "Club env"
require_regular_file "${CHECKER}" "Restore RTO drill report checker"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

backup_root="${BACKUP_HOST_DIR:-/var/backups/master-diagnostics}"
report_root="${RESTORE_RTO_DRILL_REPORT_HOST_DIR:-/var/lib/master-diagnostics/restore-rto-drills}"
report_key="${RESTORE_RTO_DRILL_REPORT_KEY_FILE:-/etc/master-diagnostics/restore-rto-drill-report.key}"
bundle_path="${backup_root}/${bundle_name}"
report_path="${report_root}/${drill_id}.json"

if [[ ! -d "${report_root}" || -L "${report_root}" ]]; then
  echo "Restore RTO drill report root is missing or unsafe: ${report_root}" >&2
  exit 1
fi
require_regular_file "${bundle_path}" "Backup bundle"
require_regular_file "${report_path}" "Restore RTO drill report"
require_regular_file "${report_key}" "Restore RTO drill report key"

bundle_sha256="sha256:$(sha256sum "${bundle_path}" | awk '{print $1}')"

exec python3 "${CHECKER}" \
  --report "${report_path}" \
  --key-file "${report_key}" \
  --expected-bundle-name "${bundle_name}" \
  --expected-bundle-sha256 "${bundle_sha256}" \
  --require-completed \
  --require-rto-met
