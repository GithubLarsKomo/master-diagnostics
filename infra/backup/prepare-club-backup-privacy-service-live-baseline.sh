#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.yml"
ENV_FILE="${BACKUP_PRIVACY_RUNTIME_ENV_FILE:-${ROOT_DIR}/.env}"
BASELINE_TOOL="${SCRIPT_DIR}/backup-privacy-service-live-baseline.py"
OUTPUT_ROOT="${BACKUP_PRIVACY_SERVICE_LIVE_BASELINE_HOST_DIR:-/var/lib/master-diagnostics/backup-privacy-service-live-baselines}"

if [[ $# -ne 5 ]]; then
  echo "Usage: bash infra/backup/prepare-club-backup-privacy-service-live-baseline.sh /absolute/activation-plan.json /absolute/pending.json /absolute/target-handoff.json /absolute/key /absolute/service-cutover-plan-v2.json" >&2
  exit 2
fi
activation_plan="$1"
pending="$2"
handoff="$3"
key_file="$4"
cutover_plan="$5"

require_regular_file() {
  local path="$1" label="$2"
  if [[ "${path}" != /* || ! -f "${path}" || -L "${path}" ]]; then
    echo "${label} is missing or unsafe: ${path}" >&2
    exit 1
  fi
}

for pair in \
  "${activation_plan}|Activation plan" \
  "${pending}|Activation PENDING evidence" \
  "${handoff}|Target handoff" \
  "${key_file}|Activation key" \
  "${cutover_plan}|Service cutover plan v2" \
  "${ENV_FILE}|Club env" \
  "${COMPOSE_FILE}|Club Compose file" \
  "${BASELINE_TOOL}|Live baseline tool"; do
  require_regular_file "${pair%%|*}" "${pair#*|}"
done

base_compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
services=(app export-cleanup retention-scan libsql caddy)
tmp_dir="$(mktemp -d)"
chmod 0700 "${tmp_dir}"
cleanup() { rm -rf -- "${tmp_dir}"; }
trap cleanup EXIT

"${base_compose[@]}" config --format json >"${tmp_dir}/compose.json"

resolve_one() {
  local service="$1"
  local ids=()
  mapfile -t ids < <("${base_compose[@]}" ps -a -q "${service}" | awk 'NF')
  if [[ ${#ids[@]} -ne 1 ]]; then
    echo "Expected exactly one existing ${service} container, found ${#ids[@]}." >&2
    exit 1
  fi
  printf '%s\n' "${ids[0]}"
}

declare -A ids
for service in "${services[@]}"; do
  ids["${service}"]="$(resolve_one "${service}")"
done
for service in "${services[@]}"; do
  docker inspect "${ids[${service}]}" >"${tmp_dir}/${service}.json"
done
for service in "${services[@]}"; do
  current="$(resolve_one "${service}")"
  if [[ "${current}" != "${ids[${service}]}" ]]; then
    echo "Container identity changed while collecting live baseline for ${service}." >&2
    exit 1
  fi
done

python3 "${BASELINE_TOOL}" prepare \
  --activation-plan "${activation_plan}" \
  --pending "${pending}" \
  --handoff "${handoff}" \
  --key-file "${key_file}" \
  --env-file "${ENV_FILE}" \
  --compose-file "${COMPOSE_FILE}" \
  --cutover-plan "${cutover_plan}" \
  --app-inspect "${tmp_dir}/app.json" \
  --export-inspect "${tmp_dir}/export-cleanup.json" \
  --retention-inspect "${tmp_dir}/retention-scan.json" \
  --libsql-inspect "${tmp_dir}/libsql.json" \
  --caddy-inspect "${tmp_dir}/caddy.json" \
  --output-root "${OUTPUT_ROOT}"
