#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
ENV_FILE="${ROOT_DIR}/.env"
PROJECT_NAME="${MASTER_DIAGNOSTICS_FRESH_INSTALL_PROJECT:-md-fresh-${GITHUB_RUN_ID:-$$}}"

if [[ -e "${ENV_FILE}" ]]; then
  echo "Fresh-install smoke requires a clean checkout without ${ENV_FILE}." >&2
  exit 1
fi
if [[ ! -f "${COMPOSE_FILE}" || -L "${COMPOSE_FILE}" ]]; then
  echo "Club Compose file is missing or unsafe." >&2
  exit 1
fi
if [[ ! "${PROJECT_NAME}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$ ]]; then
  echo "Fresh-install Compose project name is invalid." >&2
  exit 2
fi

cleanup() {
  local code=$?
  docker compose \
    --project-name "${PROJECT_NAME}" \
    --env-file "${ENV_FILE}" \
    -f "${COMPOSE_FILE}" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f -- "${ENV_FILE}"
  exit "${code}"
}
trap cleanup EXIT

cat >"${ENV_FILE}" <<'EOF'
APP_HOST=localhost
NEXT_PUBLIC_APP_URL=https://localhost
BETTER_AUTH_URL=https://localhost
BETTER_AUTH_SECRET=ci-fresh-install-secret-with-more-than-32-characters
DEPLOYMENT_MODE=club
AUTH_PROVIDER=better-auth
PRIVACY_BACKUP_STATE=DISABLED
PRIVACY_NOTIFICATIONS_STATE=DISABLED
EOF
chmod 0600 "${ENV_FILE}"

compose=(
  docker compose
  --project-name "${PROJECT_NAME}"
  --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
)

# This must be a genuinely empty Compose namespace before startup.
if docker volume ls --format '{{.Name}}' | grep -q "^${PROJECT_NAME}_"; then
  echo "Fresh-install smoke project already owns Docker volumes." >&2
  exit 1
fi
if "${compose[@]}" ps -a -q | grep -q .; then
  echo "Fresh-install smoke project already owns containers." >&2
  exit 1
fi

"${compose[@]}" config --quiet
"${compose[@]}" up -d --build

container_id() {
  local service="$1"
  local ids=()
  mapfile -t ids < <("${compose[@]}" ps -a -q "${service}" | awk 'NF')
  if [[ ${#ids[@]} -ne 1 ]]; then
    echo "Expected exactly one ${service} container, found ${#ids[@]}." >&2
    return 1
  fi
  printf '%s\n' "${ids[0]}"
}

wait_for_completed_service() {
  local service="$1" timeout_seconds="$2"
  local id deadline status exit_code
  id="$(container_id "${service}")"
  deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    status="$(docker inspect -f '{{.State.Status}}' "${id}")"
    if [[ "${status}" == exited ]]; then
      exit_code="$(docker inspect -f '{{.State.ExitCode}}' "${id}")"
      if [[ "${exit_code}" != 0 ]]; then
        echo "${service} exited with ${exit_code}." >&2
        "${compose[@]}" logs --no-color "${service}" >&2 || true
        return 1
      fi
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for ${service} to complete." >&2
  "${compose[@]}" logs --no-color "${service}" >&2 || true
  return 1
}

wait_for_running_service() {
  local service="$1" timeout_seconds="$2"
  local id deadline running health
  id="$(container_id "${service}")"
  deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    running="$(docker inspect -f '{{.State.Running}}' "${id}")"
    if [[ "${running}" == true ]]; then
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${id}")"
      if [[ "${health}" == healthy || "${health}" == none ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  echo "Timed out waiting for ${service} to become ready." >&2
  "${compose[@]}" logs --no-color "${service}" >&2 || true
  return 1
}

wait_for_completed_service migrate 120
wait_for_completed_service privacy-check 120
wait_for_running_service libsql 120
wait_for_running_service app 180
wait_for_running_service export-cleanup 120
wait_for_running_service retention-scan 120
wait_for_running_service caddy 120

# Prove the expected fresh persistent volume set was created by this namespace.
for logical in libsql-data report-data export-data data-subject-delivery-data caddy-data caddy-config; do
  docker volume inspect "${PROJECT_NAME}_${logical}" >/dev/null
done

# Health must be reachable through the actual Caddy TLS endpoint, not only inside the app container.
health_body="$(curl --fail --silent --show-error --insecure \
  --retry 20 --retry-all-errors --retry-delay 2 \
  --resolve localhost:443:127.0.0.1 \
  https://localhost/api/health)"
python3 - "${health_body}" <<'PY'
import json, sys
payload=json.loads(sys.argv[1])
if payload.get('status') != 'ok' or payload.get('service') != 'masters-diagnostics-web' or payload.get('deploymentMode') != 'club':
    raise SystemExit(f"Unexpected health payload: {payload!r}")
PY

# The fresh database volume must no longer be empty after migrations/bootstrap readiness.
libsql_id="$(container_id libsql)"
entry_count="$(docker exec "${libsql_id}" sh -c 'find /var/lib/sqld -mindepth 1 -type f | wc -l')"
if [[ ! "${entry_count}" =~ ^[0-9]+$ ]] || (( entry_count < 1 )); then
  echo "Fresh libSQL volume contains no persisted database files." >&2
  exit 1
fi

python3 - <<PY
import json
print(json.dumps({
    "mode": "CLUB_FRESH_INSTALL_SMOKE",
    "status": "HEALTHY",
    "project": "${PROJECT_NAME}",
    "migrationCompleted": True,
    "privacyPreflightCompleted": True,
    "appHealthy": True,
    "caddyTlsHealthy": True,
    "maintenanceRunning": True,
    "freshPersistentVolumes": 6,
}))
PY
