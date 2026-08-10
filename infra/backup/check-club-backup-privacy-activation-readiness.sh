#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
CHECKER="${SCRIPT_DIR}/check-backup-privacy-activation-readiness.py"
REPORT_VERIFIER="${SCRIPT_DIR}/check-restore-rto-drill-report.py"

if [[ $# -ne 2 ]]; then
  echo "Usage: bash infra/backup/check-club-backup-privacy-activation-readiness.sh drill-<32hex> masters-backup-<timestamp>-<uuid>.mdbak" >&2
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
require_regular_file "${CHECKER}" "Backup privacy activation readiness checker"
require_regular_file "${REPORT_VERIFIER}" "Canonical restore RTO drill report verifier"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

backup_root="${BACKUP_HOST_DIR:-/var/backups/master-diagnostics}"
report_root="${RESTORE_RTO_DRILL_REPORT_HOST_DIR:-/var/lib/master-diagnostics/restore-rto-drills}"
report_key="${RESTORE_RTO_DRILL_REPORT_KEY_FILE:-/etc/master-diagnostics/restore-rto-drill-report.key}"
bundle_path="${backup_root}/${bundle_name}"
report_path="${report_root}/${drill_id}.json"

for pair in \
  "${bundle_path}|Backup bundle" \
  "${report_path}|Restore RTO drill report" \
  "${report_key}|Restore RTO drill report key"; do
  require_regular_file "${pair%%|*}" "${pair#*|}"
done
if [[ ! -d "${report_root}" || -L "${report_root}" ]]; then
  echo "Restore RTO drill report root is missing or unsafe: ${report_root}" >&2
  exit 1
fi

bundle_sha256="sha256:$(sha256sum "${bundle_path}" | awk '{print $1}')"

exec python3 "${CHECKER}" \
  --report "${report_path}" \
  --key-file "${report_key}" \
  --report-verifier "${REPORT_VERIFIER}" \
  --expected-bundle-name "${bundle_name}" \
  --expected-bundle-sha256 "${bundle_sha256}"
