#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Purpose: deploy-infra's pre-pull disk gate on the env VM (scp'd to /tmp and run there).
# Scope: reclaims ONLY re-pullable caches: Docker images/build cache, k3s containerd
#   images no container references, and old journal segments. Never volumes, never
#   backups, never Postgres data.
# Invariants:
#   - IMAGE_CACHE_IS_BOUNDED (bug.5499): the k3s embedded containerd store grew ~26 GB
#     in 8h of node migrate-Job image pulls on production while kubelet image GC sat at
#     its 85% default, i.e. right at the 15% headroom crit line. Docker prune alone never
#     touched it, so the gate now prunes unused containerd images too.
#   - FAIL_ONLY_WHEN_UNSAFE: cleanup failures are logged, not fatal; only free space
#     below DISK_GATE_FATAL_AVAIL_GB after cleanup fails the deploy (unchanged contract).
set -uo pipefail

min_avail_gb="${DISK_GATE_MIN_AVAIL_GB:-7}"
max_used_pct="${DISK_GATE_MAX_USED_PCT:-70}"
fatal_avail_gb="${DISK_GATE_FATAL_AVAIL_GB:-5}"
mount_point="${DISK_GATE_MOUNT:-/}"

log() { echo "[disk-gate] $*"; }

# Prints "<avail_gb> <used_pct>" for the mount (POSIX df: 1K blocks, capacity column).
measure() {
  df -Pk "$mount_point" | awk 'NR==2 { gsub(/%/, "", $5); printf "%d %d\n", $4 / 1048576, $5 }'
}

read -r avail_gb used_pct < <(measure)
log "Disk: ${avail_gb}GB free, ${used_pct}% used"

if [ "$avail_gb" -ge "$min_avail_gb" ] && [ "$used_pct" -le "$max_used_pct" ]; then
  exit 0
fi

log "Low disk space (${avail_gb}GB free, ${used_pct}% used). Reclaiming image caches..."
docker system prune -af || log "docker system prune failed (non-fatal)"
if command -v k3s >/dev/null 2>&1; then
  # Removes every containerd image not referenced by an existing container. kubelet
  # re-pulls on demand; running pods keep theirs.
  k3s crictl rmi --prune || log "k3s crictl rmi --prune failed (non-fatal)"
else
  log "k3s not installed; skipping containerd image prune"
fi
journalctl --vacuum-time=3d || log "journalctl vacuum failed (non-fatal)"

read -r after_gb after_pct < <(measure)
log "Free space after cleanup: ${after_gb}GB (${after_pct}% used; reclaimed $((after_gb - avail_gb))GB)"

if [ "$after_gb" -lt "$fatal_avail_gb" ]; then
  log "ERROR: insufficient disk after cleanup (${after_gb}GB free)."
  exit 1
fi
exit 0
