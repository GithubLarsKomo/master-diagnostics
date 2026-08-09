#!/usr/bin/env bash
set -Eeuo pipefail

base_compose="${RESTORE_PRIVATE_PROMOTION_BASE_COMPOSE_FILE:?RESTORE_PRIVATE_PROMOTION_BASE_COMPOSE_FILE is required}"
selector_compose="${RESTORE_PRIVATE_PROMOTION_SELECTOR_COMPOSE_FILE:?RESTORE_PRIVATE_PROMOTION_SELECTOR_COMPOSE_FILE is required}"
env_file="${RESTORE_PRIVATE_PROMOTION_ENV_FILE:?RESTORE_PRIVATE_PROMOTION_ENV_FILE is required}"

for path in "${base_compose}" "${selector_compose}" "${env_file}"; do
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "Promotion selector dependency is missing or unsafe: ${path}" >&2
    exit 1
  fi
done

for name in \
  RESTORE_PRIVATE_PROMOTION_SELECTED_LIBSQL_VOLUME \
  RESTORE_PRIVATE_PROMOTION_SELECTED_REPORTS_VOLUME \
  RESTORE_PRIVATE_PROMOTION_SELECTED_TENANT_EXPORTS_VOLUME \
  RESTORE_PRIVATE_PROMOTION_SELECTED_DATA_SUBJECT_DELIVERY_VOLUME; do
  value="${!name:-}"
  if [[ ! "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "${name} is missing or unsafe." >&2
    exit 1
  fi
done

compose=(docker compose --env-file "${env_file}")
if [[ -n "${RESTORE_PRIVATE_PROMOTION_COMPOSE_PROJECT_NAME:-}" ]]; then
  if [[ ! "${RESTORE_PRIVATE_PROMOTION_COMPOSE_PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
    echo "RESTORE_PRIVATE_PROMOTION_COMPOSE_PROJECT_NAME is invalid." >&2
    exit 1
  fi
  compose+=(-p "${RESTORE_PRIVATE_PROMOTION_COMPOSE_PROJECT_NAME}")
fi
compose+=(-f "${base_compose}" -f "${selector_compose}")

# Rendering first makes missing external volumes and malformed selector input fail
# before a running service is stopped.
"${compose[@]}" config --quiet

# Only the four services that directly consume the switched application data are
# touched. Caddy is deliberately not part of this set.
"${compose[@]}" stop app export-cleanup retention-scan libsql

# Bring the database back first so the application never starts against an
# unavailable selected database. --no-deps prevents unrelated services from
# being recreated through depends_on edges.
"${compose[@]}" up -d --no-deps --force-recreate libsql
"${compose[@]}" up -d --no-deps --force-recreate app export-cleanup retention-scan
