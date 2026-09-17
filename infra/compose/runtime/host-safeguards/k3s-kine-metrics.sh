#!/usr/bin/env bash
set -euo pipefail

DB=/var/lib/rancher/k3s/server/db/state.db
TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector
METRIC_FILE="$TEXTFILE_DIR/k3s-kine.prom"

install -d -m 0755 "$TEXTFILE_DIR"
TMP_FILE=$(mktemp "$TEXTFILE_DIR/.k3s-kine.prom.XXXXXX")
trap 'rm -f "$TMP_FILE"' EXIT

if [ -f "$DB" ]; then
  SIZE=$(stat -c %s "$DB")
  cat >"$TMP_FILE" <<EOF
# HELP cogni_k3s_kine_state_db_bytes Size of the k3s kine SQLite state database.
# TYPE cogni_k3s_kine_state_db_bytes gauge
cogni_k3s_kine_state_db_bytes $SIZE
EOF
else
  : >"$TMP_FILE"
fi

chmod 0644 "$TMP_FILE"
mv -f "$TMP_FILE" "$METRIC_FILE"
trap - EXIT
