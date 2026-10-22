#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Purpose: Render the git-owned cogni-db-backup service + timer units.
# Scope: Called by deploy-infra.sh on the runtime VM; systemctl orchestration stays there.
# Invariants:
#   - GIT_OWNS_THE_SCHEDULE: unmanaged drop-ins on these units are removed, so a hand
#     edit on the VM (bug.5501) cannot silently override the reviewed cadence.
#   - WALL_CLOCK_CADENCE (story.5084): OnCalendar + Persistent. The previous
#     monotonic OnActiveSec/OnUnitInactiveSec timer restarted its 24h clock on every
#     reboot or reinstall; after the 2026-10-21 VM cutover production went 39h with
#     no backup. Persistent=true catches up a missed slot once, never repeatedly.
#   - NO_OVERLAP: Type=oneshot; a trigger while the service is active is a no-op.
set -euo pipefail

unit_dir="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
runtime="${COGNI_RUNTIME_DIR:-/opt/cogni-template-runtime}"
docker_bin="${DOCKER_BIN:-$(command -v docker)}"
on_calendar="${DB_BACKUP_ON_CALENDAR:-*-*-* 00:30:00 UTC}"
randomized_delay="${DB_BACKUP_RANDOMIZED_DELAY:-30min}"

[[ -n "$docker_bin" ]] || { echo 'db-backup: docker binary not found' >&2; exit 2; }
[[ "$on_calendar" =~ ^[A-Za-z0-9*:/,.\ -]+$ ]] || { echo 'db-backup: unsafe OnCalendar value' >&2; exit 2; }
[[ "$randomized_delay" =~ ^[0-9]+(s|min|h)?$ ]] || { echo 'db-backup: unsafe RandomizedDelaySec value' >&2; exit 2; }
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze calendar "$on_calendar" >/dev/null \
    || { echo "db-backup: invalid OnCalendar '$on_calendar'" >&2; exit 2; }
fi

for unit in cogni-db-backup.timer cogni-db-backup.service; do
  if [[ -d "$unit_dir/$unit.d" ]]; then
    for dropin in "$unit_dir/$unit.d"/*; do
      [[ -e "$dropin" ]] || continue
      echo "db-backup: removing unmanaged drop-in $dropin"
      sed 's/^/db-backup:   | /' "$dropin" || true
    done
    rm -rf "${unit_dir:?}/$unit.d"
  fi
done

compose="$docker_bin compose --project-name cogni-runtime --env-file $runtime/.env -f $runtime/docker-compose.yml --profile backup"

cat > "$unit_dir/cogni-db-backup.service" <<EOF
[Unit]
Description=Cogni runtime Postgres logical backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$runtime
ExecStart=$compose up --force-recreate --no-deps --abort-on-container-exit --exit-code-from db-backup db-backup
ExecStartPost=-$compose rm -f db-backup
TimeoutStartSec=2h
EOF

cat > "$unit_dir/cogni-db-backup.timer" <<EOF
[Unit]
Description=Run Cogni runtime Postgres logical backup

[Timer]
OnCalendar=$on_calendar
Persistent=true
RandomizedDelaySec=$randomized_delay
AccuracySec=5min
Unit=cogni-db-backup.service

[Install]
WantedBy=timers.target
EOF

echo "db-backup: units rendered (OnCalendar=$on_calendar, Persistent=true)"
