#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Hermetic proof of the runtime backup policy (story.5084, bug.5499, bug.5501):
# daily app+temporal without the weekly DBs, a weekly set, a hard write floor,
# last-copy-safe pruning, a dump budget, the git-owned wall-clock timer, and the
# deploy-infra disk gate's containerd prune. No database, Docker or systemd needed.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
backup="$repo_root/infra/compose/runtime/db-backup/backup.sh"
install_timer="$repo_root/infra/compose/runtime/db-backup/install-timer.sh"
reclaim="$repo_root/scripts/ci/lib/reclaim-vm-disk.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

mkdir -p "$fixture/bin"
cat > "$fixture/bin/pg_isready" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$fixture/bin/psql" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"-h postgres "*) printf 'cogni_operator\ncogni_poly\npostgres\n' ;;
  *) printf 'postgres\ntemporal\ntemporal_visibility\n' ;;
esac
STUB
cat > "$fixture/bin/pg_dumpall" <<'STUB'
#!/usr/bin/env bash
printf -- '-- globals\n'
STUB
# Writes FAKE_SIZE_MB_<db> MiB (default 1) to stdout, like pg_dump --format=custom.
cat > "$fixture/bin/pg_dump" <<'STUB'
#!/usr/bin/env bash
db=""
while [ $# -gt 0 ]; do [ "$1" = -d ] && db="$2"; shift; done
var="FAKE_SIZE_MB_${db}"
head -c "$(( ${!var:-1} * 1048576 ))" /dev/zero
STUB
# Free space = FAKE_DISK_FREE_MB minus everything under the backup root.
cat > "$fixture/bin/df" <<'STUB'
#!/usr/bin/env bash
used="$(du -sm "$FAKE_BACKUP_ROOT" | awk '{print $1}')"
printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\n'
printf 'fixture 100000 %s %s 50%% /\n' "$used" "$(( FAKE_DISK_FREE_MB - used ))"
STUB
chmod +x "$fixture/bin/"*

run_backup() {
  # $1 = root; remaining env set by caller.
  FAKE_BACKUP_ROOT="$1" DB_BACKUP_ROOT="$1" PATH="$fixture/bin:$PATH" \
    POSTGRES_ROOT_USER=root POSTGRES_ROOT_PASSWORD=pw \
    DB_BACKUP_OBSERVABILITY_GRACE_SECONDS=0 bash "$backup" once
}
sets() { find "$1/$2" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | sort; }
count() { sets "$1" "$2" | wc -l | tr -d ' '; }

echo "[1/8] daily app excludes the weekly DB; weekly set holds only it"
root="$fixture/r1"; mkdir -p "$root"
export FAKE_DISK_FREE_MB=1000 DB_BACKUP_MIN_FREE_MB=100 DB_BACKUP_HARD_FLOOR_MB=50
run_backup "$root" > "$fixture/r1.log"
app="$(sets "$root" app)"; weekly="$(sets "$root" app-weekly)"; temporal="$(sets "$root" temporal)"
[ -s "$app/cogni_operator.dump" ] && [ -s "$app/postgres.dump" ] || fail "daily app set incomplete"
[ ! -e "$app/cogni_poly.dump" ] || fail "daily app set still dumps cogni_poly"
[ "$(cd "$weekly" && ls ./*.dump)" = "./cogni_poly.dump" ] || fail "weekly set must hold only cogni_poly"
[ -s "$temporal/temporal.dump" ] || fail "temporal set missing"
for c in app temporal app-weekly; do
  grep -q "\"event\":\"db_backup.completed\",\"cluster\":\"$c\"" "$fixture/r1.log" || fail "no completed event for $c"
done
pass "app, temporal and app-weekly completed with the split"

echo "[2/8] weekly set is not re-dumped while fresh"
sleep 1
run_backup "$root" > "$fixture/r1b.log"
[ "$(count "$root" app-weekly)" = 1 ] || fail "weekly set re-dumped while fresh"
grep -q db_backup.weekly_not_due "$fixture/r1b.log" || fail "missing weekly_not_due event"
[ "$(count "$root" app)" = 2 ] || fail "second daily app set missing"
touch -t 202001010000 "$weekly"
sleep 1
run_backup "$root" > "$fixture/r1c.log"
[ "$(count "$root" app-weekly)" = 2 ] || fail "stale weekly set did not trigger a new weekly dump"
pass "weekly cadence follows the newest weekly set's age"

echo "[3/8] a dump can never write below the hard floor"
root="$fixture/r3"; mkdir -p "$root"
set +e
FAKE_DISK_FREE_MB=60 DB_BACKUP_MIN_FREE_MB=55 DB_BACKUP_HARD_FLOOR_MB=55 FAKE_SIZE_MB_cogni_operator=20 \
  run_backup "$root" > "$fixture/r3.log" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "oversized dump did not fail the run"
grep -q "pg_dump of database 'cogni_operator' failed" "$fixture/r3.log" || fail "oversized dump not reported"
[ -z "$(find "$root" -name '.*.tmp')" ] || fail "partial tmp set left behind"
[ "$(count "$root" app)" = 0 ] || fail "partial app set published"
grep -q '"event":"db_backup.completed","cluster":"temporal"' "$fixture/r3.log" || fail "temporal must still complete"
set +e
FAKE_DISK_FREE_MB=50 DB_BACKUP_MIN_FREE_MB=60 DB_BACKUP_HARD_FLOOR_MB=60 run_backup "$fixture/r3b" > "$fixture/r3b.log" 2>&1
rc=$?
set -e
mkdir -p "$fixture/r3b"
[ "$rc" -ne 0 ] && grep -q db_backup.headroom_refused "$fixture/r3b.log" || fail "write below floor not refused"
pass "ulimit cap kills the writer; below-floor writes are refused"

echo "[4/8] pruning never deletes the last copy of a database"
root="$fixture/r4"; mkdir -p "$root/app/20200101T000000Z-1" "$root/app/20200102T000000Z-1"
for d in "$root"/app/*; do
  for db in cogni_operator cogni_poly postgres; do head -c 1048576 /dev/zero > "$d/$db.dump"; done
done
touch -t 202001010000 "$root"/app/*
# Weekly dump fails (too big) so the legacy cogni_poly copies stay the only ones.
set +e
FAKE_DISK_FREE_MB=1000 DB_BACKUP_MIN_FREE_MB=2000 DB_BACKUP_HARD_FLOOR_MB=40 DB_BACKUP_WRITE_RESERVE_MB=0 \
  DB_BACKUP_MIN_KEEP=1 FAKE_SIZE_MB_cogni_poly=5000 run_backup "$root" > "$fixture/r4.log" 2>&1
set -e
[ -s "$root/app/20200102T000000Z-1/cogni_poly.dump" ] || fail "newest legacy cogni_poly copy was pruned"
[ ! -e "$root/app/20200101T000000Z-1" ] || fail "superseded legacy set was not pruned"
grep -q db_backup.headroom_floor "$fixture/r4.log" || fail "last-copy floor not logged"
sleep 1
FAKE_DISK_FREE_MB=1000 DB_BACKUP_MIN_FREE_MB=2000 DB_BACKUP_HARD_FLOOR_MB=40 DB_BACKUP_WRITE_RESERVE_MB=0 \
  DB_BACKUP_MIN_KEEP=1 run_backup "$root" > "$fixture/r4b.log" 2>&1 || true
[ ! -e "$root/app/20200102T000000Z-1" ] || fail "legacy set kept after a weekly copy superseded it"
pass "legacy sets drop only once every dump has a newer copy"

echo "[5/8] dump budget bounds the total and respects the keep floor"
root="$fixture/r5"; mkdir -p "$root"
for _ in 1 2 3 4; do
  FAKE_DISK_FREE_MB=1000 DB_BACKUP_MIN_FREE_MB=100 DB_BACKUP_HARD_FLOOR_MB=50 DB_BACKUP_MAX_TOTAL_MB=30 \
    FAKE_SIZE_MB_cogni_operator=4 run_backup "$root" > "$fixture/r5.log" 2>&1
  sleep 1
done
total="$(du -sm "$root/app" "$root/temporal" "$root/app-weekly" | awk '{s+=$1} END {print s}')"
[ "$total" -le 30 ] || fail "dump total ${total}MB exceeds 30MB budget"
[ "$(count "$root" app)" -ge 2 ] && [ "$(count "$root" temporal)" -ge 2 ] || fail "keep floor violated"
pass "total ${total}MB <= budget, >= 2 sets per cluster"

echo "[6/8] inconsistent floors fail closed"
set +e
DB_BACKUP_MIN_FREE_MB=100 DB_BACKUP_HARD_FLOOR_MB=200 run_backup "$fixture/r6" > /dev/null 2>&1
rc=$?
set -e
[ "$rc" = 2 ] || fail "hard floor above prune target accepted (rc=$rc)"
pass "config rejected"

echo "[7/8] git owns a wall-clock timer and removes hand drop-ins"
units="$fixture/units"; mkdir -p "$units/cogni-db-backup.timer.d"
printf '[Timer]\nOnCalendar=Sun 03:00\n' > "$units/cogni-db-backup.timer.d/10-hand.conf"
SYSTEMD_UNIT_DIR="$units" DOCKER_BIN=/usr/bin/docker PATH="/usr/bin:/bin" bash "$install_timer" > "$fixture/r7.log"
[ ! -e "$units/cogni-db-backup.timer.d" ] || fail "unmanaged drop-in survived"
grep -q 'removing unmanaged drop-in' "$fixture/r7.log" || fail "drop-in removal not logged"
grep -qx 'OnCalendar=\*-\*-\* 00:30:00 UTC' "$units/cogni-db-backup.timer" || fail "no daily OnCalendar"
grep -qx 'Persistent=true' "$units/cogni-db-backup.timer" || fail "missed runs are not caught up"
! grep -Eq '^(OnActiveSec|OnUnitInactiveSec|OnBootSec)=' "$units/cogni-db-backup.timer" || fail "monotonic trigger remains"
grep -q 'TimeoutStartSec=2h' "$units/cogni-db-backup.service" || fail "service timeout missing"
grep -q -- '--exit-code-from db-backup db-backup' "$units/cogni-db-backup.service" || fail "service exec missing"
set +e
SYSTEMD_UNIT_DIR="$units" DOCKER_BIN=/usr/bin/docker DB_BACKUP_ON_CALENDAR='daily; rm -rf /' bash "$install_timer" > /dev/null 2>&1
rc=$?
set -e
[ "$rc" = 2 ] || fail "unsafe OnCalendar accepted"
pass "OnCalendar + Persistent, drop-ins removed, unsafe values rejected"

echo "[8/8] disk gate prunes containerd images under pressure"
gate="$fixture/gate"; mkdir -p "$gate"
for tool in docker k3s journalctl; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/calls"\n' "$tool" "$gate" > "$gate/$tool"
done
printf '#!/usr/bin/env bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 100000000 80000000 %%s %%s%%%% /\\n" "$FAKE_AVAIL_KB" "$FAKE_USED_PCT"\n' > "$gate/df"
chmod +x "$gate"/*
PATH="$gate:$PATH" FAKE_AVAIL_KB=$((30 * 1048576)) FAKE_USED_PCT=60 bash "$reclaim" > /dev/null
[ ! -e "$gate/calls" ] || fail "healthy disk triggered cleanup"
PATH="$gate:$PATH" FAKE_AVAIL_KB=$((18 * 1048576)) FAKE_USED_PCT=82 bash "$reclaim" > /dev/null
grep -qx 'k3s crictl rmi --prune' "$gate/calls" || fail "containerd images not pruned"
grep -qx 'docker system prune -af' "$gate/calls" || fail "docker images not pruned"
! grep -q -- '--volumes' "$gate/calls" || fail "volume prune would delete backups"
set +e
PATH="$gate:$PATH" FAKE_AVAIL_KB=$((3 * 1048576)) FAKE_USED_PCT=97 bash "$reclaim" > /dev/null
rc=$?
set -e
[ "$rc" = 1 ] || fail "gate did not fail with <5GB after cleanup"
grep -Fq 'bash /tmp/reclaim-vm-disk.sh' "$repo_root/scripts/ci/deploy-infra.sh" || fail "deploy-infra does not run the gate"
grep -Fq 'scripts/ci/lib/reclaim-vm-disk.sh' "$repo_root/scripts/ci/deploy-infra.sh" || fail "deploy-infra does not ship the gate"
grep -Fq 'bash /opt/cogni-template-runtime/db-backup/install-timer.sh' "$repo_root/scripts/ci/deploy-infra.sh" \
  || fail "deploy-infra does not install the git-owned timer"
grep -Fq 'image-gc-high-threshold=70' "$repo_root/infra/provision/cherry/base/bootstrap.yaml" \
  || fail "kubelet image GC threshold not lowered for new provisions"
pass "containerd + docker prune under pressure, untouched when healthy, fatal below 5GB"

echo "PASS: db-backup-policy.test.sh"
