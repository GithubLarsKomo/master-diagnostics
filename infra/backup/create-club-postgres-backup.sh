#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.club.postgres.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ "${DB_ENGINE:-}" != "postgres" ]]; then
  echo "Refusing PostgreSQL backup because DB_ENGINE is not postgres" >&2
  exit 1
fi
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is required}"

backup_dir="${BACKUP_HOST_DIR:-/var/backups/master-diagnostics}"
retention="${BACKUP_RETENTION_COUNT:-30}"
[[ "$retention" =~ ^[1-9][0-9]*$ ]] || { echo "BACKUP_RETENTION_COUNT must be a positive integer" >&2; exit 1; }
install -d -m 0700 "$backup_dir"

before="$(find "$backup_dir" -maxdepth 1 -type f -name '*.pgbak' -printf '%f\n' | sort)"
backup_log="$(mktemp)"
trap 'rm -f "$backup_log"' EXIT
if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile backup run --rm \
  --user "$(id -u):$(id -g)" postgres-backup >"$backup_log" 2>&1; then
  cat "$backup_log" >&2
  echo "PostgreSQL backup container failed" >&2
  exit 1
fi
cat "$backup_log" >&2

after="$(find "$backup_dir" -maxdepth 1 -type f -name '*.pgbak' -printf '%f\n' | sort)"
new_bundle="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tail -n 1)"
[[ -n "$new_bundle" ]] || { echo "No new PostgreSQL backup bundle was created" >&2; exit 1; }
checksum_file="$backup_dir/$new_bundle.sha256"
[[ -r "$checksum_file" ]] || { echo "Missing or unreadable checksum for $new_bundle" >&2; exit 1; }
expected_sha="$(awk 'NR == 1 { print $1 }' "$checksum_file")"
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid checksum sidecar for $new_bundle" >&2; exit 1; }
actual_sha="$(sha256sum "$backup_dir/$new_bundle" | awk '{print $1}')"
[[ "$actual_sha" == "$expected_sha" ]] || { echo "Checksum mismatch for $new_bundle" >&2; exit 1; }

mapfile -t bundles < <(find "$backup_dir" -maxdepth 1 -type f -name '*.pgbak' -printf '%T@ %f\n' | sort -nr | awk '{print $2}')
if (( ${#bundles[@]} > retention )); then
  for bundle in "${bundles[@]:retention}"; do
    rm -f -- "$backup_dir/$bundle" "$backup_dir/$bundle.sha256"
  done
fi

printf '{"status":"BACKUP_OK","bundle":"%s","sha256":"%s","retained":%d}\n' "$new_bundle" "$actual_sha" "$retention"
