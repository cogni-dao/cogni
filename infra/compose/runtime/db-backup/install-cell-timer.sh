#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Purpose: Install a dedicated-cell backup job on the existing independent runtime VM scheduler.
# Scope: Existing runner-owned infra reconcile; prepares disabled units for qualified activation.
# Invariants: No new controller; no automatic enable; existing bounded native PG15 backup image.
set -euo pipefail
[[ "$(id -u)" == 0 ]] || exit 2
runtime=/opt/cogni-template-runtime
[[ -f "$runtime/db-backup/cell-backup.sh" && -d "$runtime/database-cell-backup" ]] || exit 2
docker_bin="$(command -v docker)"
cat > /etc/systemd/system/cogni-db-cell-backup.service <<EOF
[Unit]
Description=Encrypted off-Akash database cell backup
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
TimeoutStartSec=800s
ExecStart=$docker_bin compose --project-name cogni-runtime --env-file $runtime/.env -f $runtime/docker-compose.yml --profile backup run --rm --no-deps -e POSTGRES_ROOT_PASSWORD= -e TEMPORAL_DB_PASSWORD= --entrypoint /usr/local/bin/db-cell-backup.sh db-backup
EOF
cat > /etc/systemd/system/cogni-db-cell-backup.timer <<'EOF'
[Unit]
Description=Periodic encrypted off-Akash cell recovery points

[Timer]
OnCalendar=*-*-* *:00/15:00
RandomizedDelaySec=60s
AccuracySec=1s
Persistent=true
Unit=cogni-db-cell-backup.service

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
# Preserve an already qualified active schedule on reflight. First activation
# belongs to the existing maintainer after capacity, full dump and restore proof.
echo 'database cell backup timer prepared; initial activation requires qualified restore evidence'
