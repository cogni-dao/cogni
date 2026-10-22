#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

BACKUP_ROOT="${DB_BACKUP_ROOT:-/backups}"
INTERVAL_SECONDS="${DB_BACKUP_INTERVAL_SECONDS:-86400}"
# bug: 2026-09-03 production disk saturation. 14 days x ~1.5 GB/night of full
# custom-format dumps reached 21 GB on a 97 GB disk shared with k3s (sqlite/kine),
# postgres, doltgres and temporal. `/` hit 82%, iowait ran 28-35%, jbd2/vda1-8 and
# postgres sat in uninterruptible D state, and the k3s API server stalled hard enough
# that the compute-workload controller lost its leader Lease and crash-looped.
# Age alone does not bound size: dumps grow, so a fixed day count silently grows the
# footprint. Bound BOTH: a shorter age window AND a hard free-space floor.
#
# story.5084 / bug.5499 (2026-10-22): the ~20 GB cogni_poly database dominated every
# nightly app dump (~2.3 GB each, ~40 min) while it barely changes. Policy is now:
#   - app + temporal: daily, cogni_poly excluded (RPO ~24h for the small DBs);
#   - DB_BACKUP_WEEKLY_DATABASES (default cogni_poly): their own `app-weekly` set,
#     dumped when the newest weekly set is older than DB_BACKUP_WEEKLY_INTERVAL_DAYS;
#   - every dump file is written under `ulimit -f` so the filesystem can never be
#     driven below DB_BACKUP_HARD_FLOOR_MB by this job (production crit line = 15%);
#   - pruning targets DB_BACKUP_MIN_FREE_MB free AND DB_BACKUP_MAX_TOTAL_MB of dumps,
#     oldest first, but never removes the last copy of any database dump and never
#     drops a set below DB_BACKUP_MIN_KEEP.
RETENTION_DAYS="${DB_BACKUP_RETENTION_DAYS:-7}"
WEEKLY_DATABASES="${DB_BACKUP_WEEKLY_DATABASES-cogni_poly}"
WEEKLY_INTERVAL_DAYS="${DB_BACKUP_WEEKLY_INTERVAL_DAYS:-7}"
WEEKLY_RETENTION_DAYS="${DB_BACKUP_WEEKLY_RETENTION_DAYS:-14}"
MIN_FREE_MB="${DB_BACKUP_MIN_FREE_MB:-21000}"
HARD_FLOOR_MB="${DB_BACKUP_HARD_FLOOR_MB:-16000}"
MAX_TOTAL_MB="${DB_BACKUP_MAX_TOTAL_MB:-8192}"
MIN_KEEP="${DB_BACKUP_MIN_KEEP:-2}"
# Space the next writes need above the hard floor. Below HARD_FLOOR + RESERVE the
# keep floor relaxes to the newest copy of each database so a write is never
# starved by redundant older sets (the 2026-10-21 prod state: 17.5 GB free).
WRITE_RESERVE_MB="${DB_BACKUP_WRITE_RESERVE_MB:-3000}"
OBSERVABILITY_GRACE_SECONDS="${DB_BACKUP_OBSERVABILITY_GRACE_SECONDS:-90}"
# Backup sets owned by this job. database-cells/ belongs to cell-backup.sh.
BACKUP_SETS="app app-weekly temporal"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

log_json() {
  local level="$1" event="$2" cluster="$3" message="$4" path="${5:-}"
  printf '{"level":"%s","event":"%s","cluster":"%s","msg":"%s","path":"%s","time":"%s"}\n' \
    "$(json_escape "$level")" \
    "$(json_escape "$event")" \
    "$(json_escape "$cluster")" \
    "$(json_escape "$message")" \
    "$(json_escape "$path")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

require_positive_int() {
  local name="$1" value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ]; then
    log_json error db_backup.config "" "$name must be a positive integer"
    exit 2
  fi
}

require_nonnegative_int() {
  local name="$1" value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    log_json error db_backup.config "" "$name must be a non-negative integer"
    exit 2
  fi
}

wait_for_postgres() {
  local cluster="$1" host="$2" port="$3" user="$4"
  local deadline=$((SECONDS + 120))
  until pg_isready -h "$host" -p "$port" -U "$user" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      log_json error db_backup.unreachable "$cluster" "postgres did not become ready before timeout"
      return 1
    fi
    sleep 2
  done
}

safe_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

write_manifest() {
  local dir="$1"
  (
    cd "$dir"
    find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256
  )
}

free_mb() {
  df -Pm "$1" 2>/dev/null | awk 'NR==2 {print $4}'
}

# A set's family is the Postgres cluster it was dumped from: app and app-weekly
# hold disjoint databases of the same server, so they cover each other.
set_family() {
  case "$1" in
    app|app-weekly) echo "app app-weekly" ;;
    *) echo "$1" ;;
  esac
}

# Completed backup directories across every owned set, oldest first, as
# "<set> <path>". Directory names start with a UTC timestamp, so a name sort is
# chronological across sets.
list_backups() {
  local set
  for set in $BACKUP_SETS; do
    [ -d "$BACKUP_ROOT/$set" ] || continue
    find "$BACKUP_ROOT/$set" -mindepth 1 -maxdepth 1 -type d ! -name '.*' \
      -exec sh -c 'for d; do printf "%s %s %s\n" "${d##*/}" "$0" "$d"; done' "$set" {} +
  done | sort | cut -d' ' -f2-
}

set_count() {
  [ -d "$BACKUP_ROOT/$1" ] || { echo 0; return; }
  find "$BACKUP_ROOT/$1" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l | tr -d '[:space:]'
}

# True when every database dump in $2 also exists in a NEWER backup of the same
# family. Pruning never deletes the last copy of a database; dropping a database's
# final backup is an explicit human decision (bug.5501), not a retention side effect.
is_superseded() {
  local set="$1" dir="$2" name dump base sibling found
  name="$(basename "$dir")"
  for dump in "$dir"/*.dump; do
    [ -e "$dump" ] || continue
    base="$(basename "$dump")"
    found=0
    for sibling in $(set_family "$set"); do
      [ -d "$BACKUP_ROOT/$sibling" ] || continue
      while IFS= read -r other; do
        [ "$(basename "$other")" \> "$name" ] || continue
        if [ -s "$other/$base" ]; then found=1; break; fi
      done < <(find "$BACKUP_ROOT/$sibling" -mindepth 1 -maxdepth 1 -type d ! -name '.*')
      [ "$found" -eq 1 ] && break
    done
    [ "$found" -eq 1 ] || return 1
  done
  return 0
}

is_removable() {
  local set="$1" dir="$2" keep="${3:-$MIN_KEEP}"
  [ "$(set_count "$set")" -gt "$keep" ] && is_superseded "$set" "$dir"
}

total_backup_mb() {
  local set total=0 mb
  for set in $BACKUP_SETS; do
    [ -d "$BACKUP_ROOT/$set" ] || continue
    mb="$(du -sm "$BACKUP_ROOT/$set" 2>/dev/null | awk '{print $1}')"
    total=$((total + ${mb:-0}))
  done
  echo "$total"
}

# 1. Age: drop sets older than their retention window when removable.
# 2. Pressure: while free < MIN_FREE_MB or dumps > MAX_TOTAL_MB, drop the oldest
#    removable set (keep floor MIN_KEEP, relaxed to 1 when free space cannot fit the
#    next writes above the hard floor). If nothing is removable, log loudly and stop:
#    a full disk is an outage, but zero recoverable backups is worse.
prune_backups() {
  local set dir retention free total victim victim_set keep

  while read -r set dir; do
    [ -n "$dir" ] || continue
    retention="$RETENTION_DAYS"
    [ "$set" = app-weekly ] && retention="$WEEKLY_RETENTION_DAYS"
    [ -n "$(find "$dir" -maxdepth 0 -mtime +"$retention")" ] || continue
    is_removable "$set" "$dir" || continue
    log_json info db_backup.retention_prune "$set" "older than ${retention}d; pruning" "$dir"
    rm -rf "$dir"
  done < <(list_backups)

  while :; do
    free="$(free_mb "$BACKUP_ROOT")"
    [ -n "$free" ] || break
    total="$(total_backup_mb)"
    if [ "$free" -ge "$MIN_FREE_MB" ] && [ "$total" -le "$MAX_TOTAL_MB" ]; then
      break
    fi
    keep="$MIN_KEEP"
    [ "$free" -ge $((HARD_FLOOR_MB + WRITE_RESERVE_MB)) ] || keep=1
    victim=""
    while read -r set dir; do
      [ -n "$dir" ] || continue
      if is_removable "$set" "$dir" "$keep"; then victim="$dir"; victim_set="$set"; break; fi
    done < <(list_backups)
    if [ -z "$victim" ]; then
      # warn while the next writes still fit above the hard floor; error when not.
      log_json "$([ "$keep" = 1 ] && echo error || echo warn)" db_backup.headroom_floor all \
        "${free}MB free (target ${MIN_FREE_MB}MB), ${total}MB of dumps (budget ${MAX_TOTAL_MB}MB); every remaining set is a last copy or within the keep floor" \
        "$BACKUP_ROOT"
      break
    fi
    log_json warn db_backup.headroom_prune "$victim_set" \
      "${free}MB free (target ${MIN_FREE_MB}MB), ${total}MB of dumps (budget ${MAX_TOTAL_MB}MB); pruning oldest removable backup" \
      "$victim"
    rm -rf "$victim"
  done
}

# Run "$@" with stdout to $out, unable to write past HARD_FLOOR_MB of free space.
# bash's `ulimit -f` counts 1024-byte blocks; exceeding it raises SIGXFSZ, so the
# writer dies non-zero and the caller fails closed instead of filling the disk.
bounded_write() {
  local cluster="$1" out="$2" free cap_mb
  shift 2
  free="$(free_mb "$BACKUP_ROOT")"
  cap_mb=$(( ${free:-0} - HARD_FLOOR_MB ))
  if [ "$cap_mb" -le 0 ]; then
    log_json error db_backup.headroom_refused "$cluster" \
      "only ${free:-unknown}MB free; refusing to write below the ${HARD_FLOOR_MB}MB hard floor" "$out"
    return 1
  fi
  ( ulimit -f "$((cap_mb * 1024))"; "$@" > "$out" )
}

# Prints the databases this run dumps for a set, one per line.
select_databases() {
  local mode="$1" db
  while IFS= read -r db; do
    [ -n "$db" ] || continue
    case "$mode" in
      all) printf '%s\n' "$db" ;;
      daily) is_weekly_database "$db" || printf '%s\n' "$db" ;;
      weekly) ! is_weekly_database "$db" || printf '%s\n' "$db" ;;
    esac
  done
}

is_weekly_database() {
  local w
  for w in $WEEKLY_DATABASES; do
    [ "$w" = "$1" ] && return 0
  done
  return 1
}

# Due when no weekly set exists or the newest is older than the interval less a
# 12h tolerance, so timer jitter never pushes a weekly dump out by a whole week.
weekly_due() {
  local newest
  [ -n "$WEEKLY_DATABASES" ] || return 1
  newest="$(list_backups | awk '$1 == "app-weekly" {print $2}' | tail -1)"
  [ -n "$newest" ] || return 0
  [ -n "$(find "$newest" -maxdepth 0 -mmin +$((WEEKLY_INTERVAL_DAYS * 1440 - 720)))" ]
}

backup_cluster() {
  local cluster="$1" host="$2" port="$3" user="$4" password="$5" mode="${6:-all}"
  local timestamp tmp_dir final_dir dbs db db_file

  export PGPASSWORD="$password"

  # FAIL-CLOSED CONTRACT (prod 2026-08-05 incident): run_once invokes this as
  # `backup_cluster … || failed=1`, which DISABLES `set -e` for the entire function
  # (bash neuters errexit for any command that is the left operand of && / ||). So
  # every fallible step below is checked EXPLICITLY and returns non-zero on failure.
  # Without this, a failed dump (e.g. the superuser password drifting so pg_dumpall
  # gets `password authentication failed` and writes a 0-byte globals.sql) falls
  # through to the `db_backup.completed` log — a silent-success that makes the
  # completion event + a Loki hit look like a real backup when nothing was captured.
  # `db_backup.completed` is emitted ONLY after every dump in this cluster succeeded.
  if ! wait_for_postgres "$cluster" "$host" "$port" "$user"; then
    return 1
  fi

  if ! dbs="$(psql -h "$host" -p "$port" -U "$user" -d postgres -At \
      -c "select datname from pg_database where datallowconn and not datistemplate order by datname")"; then
    log_json error db_backup.failed "$cluster" "enumerating databases failed"
    return 1
  fi
  dbs="$(printf '%s\n' "$dbs" | select_databases "$mode")"
  if [ -z "$dbs" ]; then
    log_json info db_backup.skipped "$cluster" "no databases selected for this set"
    return 0
  fi

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  tmp_dir="$BACKUP_ROOT/.${cluster}.${timestamp}.tmp"
  final_dir="$BACKUP_ROOT/${cluster}/${timestamp}"

  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir" "$BACKUP_ROOT/$cluster"

  log_json info db_backup.started "$cluster" "starting postgres backup"

  if ! bounded_write "$cluster" "$tmp_dir/globals.sql" \
      pg_dumpall -h "$host" -p "$port" -U "$user" --globals-only; then
    log_json error db_backup.failed "$cluster" "pg_dumpall --globals-only failed (auth/connectivity/headroom?)"
    rm -rf "$tmp_dir"
    return 1
  fi

  while IFS= read -r db; do
    [ -n "$db" ] || continue
    db_file="$(safe_name "$db").dump"
    if ! bounded_write "$cluster" "$tmp_dir/$db_file" \
        pg_dump -h "$host" -p "$port" -U "$user" -d "$db" --format=custom; then
      log_json error db_backup.failed "$cluster" "pg_dump of database '$db' failed (or hit the headroom floor)"
      rm -rf "$tmp_dir"
      return 1
    fi
  done <<< "$dbs"

  write_manifest "$tmp_dir"
  mv "$tmp_dir" "$final_dir"
  log_json info db_backup.completed "$cluster" "postgres backup completed" "$final_dir"
  prune_backups
}

run_once() {
  local failed=0 root_user root_password
  root_user="${POSTGRES_ROOT_USER:?POSTGRES_ROOT_USER is required}"
  root_password="${POSTGRES_ROOT_PASSWORD:?POSTGRES_ROOT_PASSWORD is required}"

  # Free space BEFORE writing, then the small daily sets first so a large weekly
  # dump can never cost the daily recovery point.
  prune_backups
  backup_cluster app postgres 5432 "$root_user" "$root_password" daily || failed=1
  backup_cluster temporal temporal-postgres 5432 "${TEMPORAL_DB_USER:-temporal}" "${TEMPORAL_DB_PASSWORD:-temporal}" all || failed=1
  if weekly_due; then
    backup_cluster app-weekly postgres 5432 "$root_user" "$root_password" weekly || failed=1
  else
    log_json info db_backup.weekly_not_due app-weekly "newest weekly set is younger than ${WEEKLY_INTERVAL_DAYS}d"
  fi

  if [ "$failed" -eq 0 ]; then
    log_json info db_backup.run_completed all "all postgres backups completed"
    return 0
  fi

  log_json error db_backup.run_failed all "one or more postgres backups failed"
  return 1
}

main() {
  require_positive_int DB_BACKUP_INTERVAL_SECONDS "$INTERVAL_SECONDS"
  require_positive_int DB_BACKUP_RETENTION_DAYS "$RETENTION_DAYS"
  require_positive_int DB_BACKUP_WEEKLY_INTERVAL_DAYS "$WEEKLY_INTERVAL_DAYS"
  require_positive_int DB_BACKUP_WEEKLY_RETENTION_DAYS "$WEEKLY_RETENTION_DAYS"
  require_positive_int DB_BACKUP_MIN_FREE_MB "$MIN_FREE_MB"
  require_positive_int DB_BACKUP_HARD_FLOOR_MB "$HARD_FLOOR_MB"
  require_positive_int DB_BACKUP_MAX_TOTAL_MB "$MAX_TOTAL_MB"
  require_positive_int DB_BACKUP_MIN_KEEP "$MIN_KEEP"
  require_nonnegative_int DB_BACKUP_WRITE_RESERVE_MB "$WRITE_RESERVE_MB"
  require_nonnegative_int DB_BACKUP_OBSERVABILITY_GRACE_SECONDS "$OBSERVABILITY_GRACE_SECONDS"
  if [ "$HARD_FLOOR_MB" -gt "$MIN_FREE_MB" ]; then
    log_json error db_backup.config "" "DB_BACKUP_HARD_FLOOR_MB must not exceed DB_BACKUP_MIN_FREE_MB"
    exit 2
  fi
  mkdir -p "$BACKUP_ROOT"

  case "${1:-once}" in
    once)
      local status=0
      run_once || status=$?
      if [ "$OBSERVABILITY_GRACE_SECONDS" -gt 0 ]; then
        log_json info db_backup.observe_grace all "waiting for log collection before exit"
        sleep "$OBSERVABILITY_GRACE_SECONDS"
      fi
      return "$status"
      ;;
    *)
      echo "Usage: $0 [once]" >&2
      exit 2
      ;;
  esac
}

main "$@"
