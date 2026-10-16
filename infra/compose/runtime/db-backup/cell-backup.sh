#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Purpose: Back up dedicated cells to encrypted storage on the independent runtime VM.
# Scope: Existing bounded PG15 db-backup container; sole-writer kits projected read-only.
# Invariants: No provider root/control/CA-key custody; no plaintext archive; failed dumps never complete.
set -euo pipefail
umask 077

kit_root="${DATABASE_CELL_BACKUP_KIT_ROOT:-/database-cell-backup}"
backup_root="${DB_BACKUP_ROOT:-/backups}/database-cells"
minimum_free_mib="${DATABASE_CELL_BACKUP_MIN_FREE_MIB:-15000}"
maximum_archive_mib="${DATABASE_CELL_BACKUP_MAX_ARCHIVE_MIB:-2800}"
retain="${DATABASE_CELL_BACKUP_RETAIN:-1}"
interval_seconds="${DATABASE_CELL_BACKUP_INTERVAL_SECONDS:-900}"
jitter_seconds="${DATABASE_CELL_BACKUP_MAX_JITTER_SECONDS:-61}"
# Includes container startup and the bounded worker; matches the installed unit.
scheduled_job_timeout_seconds=800
for setting in minimum_free_mib maximum_archive_mib retain interval_seconds jitter_seconds; do
  [[ "${!setting}" =~ ^[1-9][0-9]*$ ]] || exit 2
done
[[ "$interval_seconds" -ge 900 && "$jitter_seconds" -ge 61 ]] || {
  echo 'backup receipt cannot understate installed schedule bounds' >&2; exit 2;
}
if [[ "${DATABASE_CELL_BACKUP_BOUNDED_RUN:-0}" != 1 ]]; then
  # Covers metadata connects, dump, encryption, verification and retention. The
  # process group is terminated before the shortest jittered 15-minute spacing.
  export DATABASE_CELL_BACKUP_BOUNDED_RUN=1
  exec timeout --kill-after=10s 780s bash "$0" "$@"
fi
export PGCONNECT_TIMEOUT=5
[[ "$(pg_dump --version)" == *' 15.'* ]] || { echo 'version-matched PG15 dump required' >&2; exit 2; }
[[ -d "$kit_root" ]] || { echo 'private backup kit projection missing' >&2; exit 2; }
mkdir -p "$backup_root"

partial=""
trap '[[ -z "$partial" ]] || rm -rf "$partial"' EXIT
found=0
prune_completed() {
  local target_root=$1 kept=0 existing
  while IFS= read -r existing; do
    [[ -f "$existing/receipt.json" && -f "$existing/MANIFEST.sha256" && -f "$existing/database.dump.enc" && ! -f "$existing/PINNED" ]] || continue
    kept=$((kept + 1))
    [[ "$kept" -le "$retain" ]] || rm -rf "$existing"
  done < <(find "$target_root" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | sort -r)
}
for kit in "$kit_root"/*; do
  [[ -d "$kit" ]] || continue
  [[ -s "$kit/targets.tsv" && -s "$kit/pg_service.conf" && -s "$kit/encryption.key" && -s "$kit/ca.crt" ]] || exit 2
  export PGSERVICEFILE="$kit/pg_service.conf" PGSSLROOTCERT="$kit/ca.crt" PGSSLMODE=verify-full
  while IFS=$'\t' read -r service database environment node_id binding_system; do
    [[ -n "$service" ]] || continue
    [[ "$service" =~ ^[a-z][a-z0-9_]*$ && "$database" =~ ^cogni_[a-z0-9_]+$ ]] || exit 2
    [[ "$environment" =~ ^(candidate-a|preview|production)$ && "$node_id" =~ ^[0-9a-f-]{36}$ && "$binding_system" =~ ^[0-9]+$ ]] || exit 2
    found=1
    target_root="$backup_root/$node_id/$environment/$database"
    mkdir -p "$target_root"
    # Keep the latest completed point and every pin while freeing only excess
    # cell-specific completed points before admitting another bounded archive.
    prune_completed "$target_root"
    free_mib="$(df -Pm "$backup_root" | awk 'NR==2 {print $4}')"
    [[ "$free_mib" =~ ^[0-9]+$ && "$free_mib" -ge $((minimum_free_mib + maximum_archive_mib)) ]] || {
      echo 'independent backup filesystem lacks bounded archive headroom' >&2; exit 1;
    }
    actual_database="$(psql "service=$service" -XAtv ON_ERROR_STOP=1 -c 'SELECT current_database()')"
    [[ "$actual_database" == "$database" ]] || exit 1
    native_identity="$(psql "service=$service" -XAtv ON_ERROR_STOP=1 \
      -v database="$database" -v role="backup_${database#cogni_}" -v system="$binding_system" <<'SQL'
WITH identity AS (SELECT public.database_backup_identity() AS value)
SELECT value->>'databaseName' = :'database' AND value->>'role' = :'role'
  AND value->>'systemIdentifier' = :'system'
  AND value->>'backupRoleIsolated' = 'true' AND value->>'allTablesReadable' = 'true' FROM identity;
SQL
    )"
    [[ "$native_identity" == t ]] || { echo 'backup native allocation identity mismatch' >&2; exit 1; }
    server_version="$(psql "service=$service" -XAtv ON_ERROR_STOP=1 -c 'SHOW server_version_num')"
    [[ "$server_version" =~ ^15[0-9]{4}$ ]] || { echo 'server is not PG15; refuse mismatched dump' >&2; exit 1; }
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    started_epoch="$(date +%s)"
    receipt_id="$(cat /proc/sys/kernel/random/uuid)"
    partial="$target_root/.${receipt_id}.partial"
    mkdir "$partial"
    archive="$partial/database.dump.enc"
    # Bash's Linux file-size limit is KiB. The pipeline fails closed if any
    # native dump, encryption, archive cap or transport operation fails.
    (
      ulimit -f "$((maximum_archive_mib * 1024))"
      pg_dump "service=$service" --format=custom --compress=3 --exclude-schema=cogni_control |
        openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 \
          -pass "file:$kit/encryption.key" -out "$archive"
    )
    # Validate every archive payload through the native reader without persisting
    # decrypted data. Restore into a real cell remains a separate required gate.
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
      -pass "file:$kit/encryption.key" -in "$archive" | pg_restore --file=/dev/null
    archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
    archive_bytes="$(stat -c %s "$archive")"
    completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    duration_seconds="$(( $(date +%s) - started_epoch + 1 ))"
    # A fast current dump cannot bound the NEXT scheduled job's completion.
    # This conditional budget includes its full unit timeout. Missed/failed
    # schedules require actual recovery-point age, not this nominal bound.
    printf '{"version":1,"event":"database_cell.backup_completed","receiptId":"%s","nodeId":"%s","environment":"%s","database":"%s","bindingSystemIdentifier":"%s","startedAt":"%s","completedAt":"%s","durationSeconds":%s,"archiveBytes":%s,"archiveSha256":"%s","intervalSeconds":%s,"maximumJitterSeconds":%s,"rpoBoundSeconds":%s,"scheduledJobTimeoutSeconds":%s,"rpoAssumption":"successful_schedule_without_failed_or_skipped_runs","currentRpoBoundSeconds":null,"maximumArchiveMiB":%s,"minimumFreeMiB":%s,"retainUnpinned":%s}\n' \
      "$receipt_id" "$node_id" "$environment" "$database" "$binding_system" \
      "$started_at" "$completed_at" "$duration_seconds" "$archive_bytes" "$archive_sha" \
      "$interval_seconds" "$jitter_seconds" "$((interval_seconds + jitter_seconds + scheduled_job_timeout_seconds))" \
      "$scheduled_job_timeout_seconds" \
      "$maximum_archive_mib" "$minimum_free_mib" "$retain" \
      > "$partial/receipt.json"
    (cd "$partial" && sha256sum database.dump.enc receipt.json > MANIFEST.sha256)
    final="$target_root/$(date -u +%Y%m%dT%H%M%SZ)-$receipt_id"
    mv "$partial" "$final"
    partial=""
    # A cutover packet may pin its exact restore point. Prune only unpinned
    # completed artifacts; the free-space gate still bounds future writes.
    prune_completed "$target_root"
    cat "$final/receipt.json"
  done < "$kit/targets.tsv"
done
[[ "$found" == 1 ]] || { echo 'no private cell backup targets' >&2; exit 2; }
