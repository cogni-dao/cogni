#!/usr/bin/env bash
set -euo pipefail

DB=/var/lib/rancher/k3s/server/db/state.db
# Below this the reclaim cannot pay for the API-server restart it costs.
MIN_BYTES=536870912

[ -f "$DB" ] || { echo "kine-compact: no state.db; nothing to do"; exit 0; }
SIZE=$(stat -c %s "$DB")
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  echo "kine-compact: state.db is $SIZE bytes, under threshold $MIN_BYTES; skipping"
  exit 0
fi

# VACUUM rewrites the entire database, so it needs headroom equal to the
# current file. Pin SQLite's temporary copy to the database filesystem so the
# headroom check measures the filesystem that receives the write.
export SQLITE_TMPDIR=/var/lib/rancher/k3s/server/db
AVAIL=$(df -PB1 "$SQLITE_TMPDIR" | awk 'NR==2 {print $4}')
if [ "$AVAIL" -lt "$SIZE" ]; then
  echo "kine-compact: need $SIZE bytes free, have $AVAIL - refusing"
  exit 1
fi

echo "kine-compact: state.db $SIZE bytes; stopping k3s"
# Arm before the stop: even a failed stop must attempt to return k3s to service.
trap 'systemctl start k3s' EXIT
systemctl stop k3s
ROWS_BEFORE=$(sqlite3 "$DB" 'SELECT count(*) FROM kine;')
# Keep the newest revision per key, including delete tombstones. This is the
# exact operation proven during bug.5105 production recovery.
sqlite3 "$DB" 'DELETE FROM kine WHERE id NOT IN (SELECT MAX(id) FROM kine GROUP BY name);'
sqlite3 "$DB" 'VACUUM;'
ROWS_AFTER=$(sqlite3 "$DB" 'SELECT count(*) FROM kine;')
NEW=$(stat -c %s "$DB")
echo "kine-compact: rows $ROWS_BEFORE -> $ROWS_AFTER; $SIZE -> $NEW bytes (reclaimed $((SIZE - NEW)))"
