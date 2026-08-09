#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

# This wrapper is intentionally only a static policy checker for the values
# supplied in its process environment. It does not inspect or restart the
# already-running Club services. Therefore it must never authorize the
# transition to productive ENABLED runtime state by itself.
if [[ "${PRIVACY_BACKUP_STATE:-}" == "ENABLED" ]]; then
  printf '%s\n' '{"readyForIrreversibleProcessing":false,"backupState":"ENABLED","notificationsState":"UNDECLARED","backupPolicyVersion":"1.0.0","notificationPolicyVersion":null,"attestationScope":"STATIC_ENV_POLICY_ONLY","blockers":["LIVE_RUNTIME_ATTESTATION_REQUIRED"]}'
  exit 1
fi

exec pnpm --silent privacy-capabilities:check
