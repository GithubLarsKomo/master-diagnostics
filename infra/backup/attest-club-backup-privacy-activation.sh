#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
WRITER="${SCRIPT_DIR}/write-backup-privacy-manual-attestation.py"
VERIFIER="${SCRIPT_DIR}/check-backup-privacy-manual-attestation.py"
READINESS_CHECKER="${SCRIPT_DIR}/check-backup-privacy-activation-readiness.py"
REPORT_VERIFIER="${SCRIPT_DIR}/check-restore-rto-drill-report.py"
ACK=--acknowledge-operational-responsibility

if [[ $# -ne 4 ]]; then
  echo "Usage: bash infra/backup/attest-club-backup-privacy-activation.sh drill-<32hex> masters-backup-<timestamp>-<uuid>.mdbak <attestor-id> --acknowledge-operational-responsibility" >&2
  exit 2
fi

drill_id="$1"
bundle_name="$2"
attestor_id="$3"
acknowledgement="$4"

if [[ ! "${drill_id}" =~ ^drill-[0-9a-f]{32}$ ]]; then
  echo "Restore RTO drill ID is invalid." >&2
  exit 2
fi
if [[ ! "${bundle_name}" =~ ^masters-backup-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdbak$ ]]; then
  echo "Backup file name is invalid." >&2
  exit 2
fi
if [[ ! "${attestor_id}" =~ ^[A-Za-z0-9._@:-]{1,128}$ ]]; then
  echo "Attestor ID is invalid." >&2
  exit 2
fi
if [[ "${acknowledgement}" != "${ACK}" ]]; then
  echo "Explicit operational responsibility acknowledgement is required." >&2
  exit 2
fi

require_regular_file() {
  local path="$1" label="$2"
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

for pair in \
  "${ENV_FILE}|Club env" \
  "${WRITER}|Manual attestation writer" \
  "${VERIFIER}|Manual attestation verifier" \
  "${READINESS_CHECKER}|Activation readiness checker" \
  "${REPORT_VERIFIER}|Restore RTO drill report verifier"; do
  require_regular_file "${pair%%|*}" "${pair#*|}"
done

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ "${PRIVACY_BACKUP_STATE:-}" != "DISABLED" ]]; then
  echo "Backup privacy capability must remain DISABLED while manual attestation is created." >&2
  exit 1
fi

backup_root="${BACKUP_HOST_DIR:-/var/backups/master-diagnostics}"
report_root="${RESTORE_RTO_DRILL_REPORT_HOST_DIR:-/var/lib/master-diagnostics/restore-rto-drills}"
drill_key="${RESTORE_RTO_DRILL_REPORT_KEY_FILE:-/etc/master-diagnostics/restore-rto-drill-report.key}"
attestation_root="${BACKUP_PRIVACY_MANUAL_ATTESTATION_HOST_DIR:-/var/lib/master-diagnostics/backup-privacy-attestations}"
attestation_key="${BACKUP_PRIVACY_MANUAL_ATTESTATION_KEY_FILE:-/etc/master-diagnostics/backup-privacy-manual-attestation.key}"
bundle_path="${backup_root}/${bundle_name}"
report_path="${report_root}/${drill_id}.json"

for pair in \
  "${bundle_path}|Backup bundle" \
  "${report_path}|Restore RTO drill report" \
  "${drill_key}|Restore RTO drill report key" \
  "${attestation_key}|Manual attestation key"; do
  require_regular_file "${pair%%|*}" "${pair#*|}"
done

if [[ ! -d "${report_root}" || -L "${report_root}" ]]; then
  echo "Restore RTO drill report root is missing or unsafe: ${report_root}" >&2
  exit 1
fi
if [[ -e "${attestation_root}" && ( ! -d "${attestation_root}" || -L "${attestation_root}" ) ]]; then
  echo "Manual attestation root is unsafe: ${attestation_root}" >&2
  exit 1
fi

attestation_id="attestation-$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
attested_at="$(python3 -c 'from datetime import datetime,timezone; print(datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))')"

tmp_dir="$(mktemp -d)"
chmod 0700 "${tmp_dir}"
cleanup() { rm -rf -- "${tmp_dir}"; }
trap cleanup EXIT
writer_output="${tmp_dir}/writer.json"
verified_output="${tmp_dir}/verified.json"

python3 "${WRITER}" \
  --readiness-checker "${READINESS_CHECKER}" \
  --report-verifier "${REPORT_VERIFIER}" \
  --drill-report "${report_path}" \
  --drill-key-file "${drill_key}" \
  --backup-bundle "${bundle_path}" \
  --attestation-key-file "${attestation_key}" \
  --output-dir "${attestation_root}" \
  --attestation-id "${attestation_id}" \
  --attestor-id "${attestor_id}" \
  --attested-at "${attested_at}" \
  "${ACK}" >"${writer_output}"

attestation_path="$(python3 - "${writer_output}" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
if r.get('status') != 'ATTESTATION_PERSISTED':
    raise SystemExit(1)
print(r['attestationPath'])
PY
)"

python3 "${VERIFIER}" \
  --attestation "${attestation_path}" \
  --key-file "${attestation_key}" >"${verified_output}"

python3 - "${writer_output}" "${verified_output}" "${attestation_path}" <<'PY'
import json,sys
writer=json.load(open(sys.argv[1]))
verified=json.load(open(sys.argv[2]))
if verified.get('status') != 'ATTESTATION_VERIFIED':
    raise SystemExit(1)
if verified.get('runtimeConfigurationChanged') is not False or verified.get('automaticActivationPerformed') is not False:
    raise SystemExit(1)
print(json.dumps({
    'mode': 'CLUB_BACKUP_PRIVACY_MANUAL_ATTESTATION',
    'status': 'MANUAL_ATTESTATION_VERIFIED',
    'attestationPath': sys.argv[3],
    'attestationId': verified['attestationId'],
    'attestationFingerprint': verified['attestationFingerprint'],
    'drillId': verified['drillId'],
    'drillReportFingerprint': verified['drillReportFingerprint'],
    'attestorId': verified['attestorId'],
    'privacyBackupActivationAllowed': verified['privacyBackupActivationAllowed'],
    'runtimeConfigurationChanged': False,
    'automaticActivationPerformed': False,
    'attestationCreated': writer.get('attestationCreated'),
}, separators=(',', ':'), ensure_ascii=False))
PY
