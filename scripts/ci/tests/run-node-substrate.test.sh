#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Proves the per-node substrate runner wires materialize → reconcile uniformly:
#   - both callees run, in order, with the SAME (env, node) args;
#   - reconcile runs ONLY after materialize succeeds (fail-fast on materialize);
#   - exit code propagates (a failing callee fails the runner).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_ROOT/scripts/ci/run-node-substrate.sh"

TMPROOT=$(mktemp -d -t run-node-substrate.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
ORDER="$TMPROOT/order.log"

mk_stub() {
  # mk_stub <path> <tag> <exit_code>
  cat > "$1" <<EOF
#!/usr/bin/env bash
echo "$2 \$1 \$2" >> "$ORDER"
exit $3
EOF
  chmod +x "$1"
}

# ── Case 1: happy path — materialize then reconcile, same args, in order ──────
mk_stub "$TMPROOT/mat.sh" materialize 0
mk_stub "$TMPROOT/rec.sh" reconcile 0
: > "$ORDER"
RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/mat.sh" \
RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/rec.sh" \
  bash "$RUNNER" candidate-a node-template >/dev/null

got="$(paste -sd'|' - < "$ORDER")"
want="materialize candidate-a node-template|reconcile candidate-a node-template"
[ "$got" = "$want" ] || { echo "order/args mismatch:
  got:  $got
  want: $want" >&2; exit 1; }

# ── Case 2: materialize fails → reconcile must NOT run; runner exits non-zero ──
mk_stub "$TMPROOT/mat.sh" materialize 7
mk_stub "$TMPROOT/rec.sh" reconcile 0
: > "$ORDER"
if RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/mat.sh" \
   RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/rec.sh" \
     bash "$RUNNER" preview operator >/dev/null 2>&1; then
  echo "runner must fail when materialize fails" >&2; exit 1
fi
if grep -q '^reconcile' "$ORDER"; then
  echo "reconcile must NOT run after materialize failure" >&2; exit 1
fi

# ── Case 3: reconcile failure propagates ─────────────────────────────────────
mk_stub "$TMPROOT/mat.sh" materialize 0
mk_stub "$TMPROOT/rec.sh" reconcile 3
if RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/mat.sh" \
   RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/rec.sh" \
     bash "$RUNNER" production poly >/dev/null 2>&1; then
  echo "runner must fail when reconcile fails" >&2; exit 1
fi

# ── Case 4: a relative COGNI_CATALOG_ROOT is anchored to APP_SOURCE_DIR and
#    exported ABSOLUTE to both callees (the candidate-flight `infra/catalog` bug:
#    image-tags.sh in materialize globs it cwd-relative and 404s otherwise). ─────
APPDIR="$TMPROOT/appsrc"
mkdir -p "$APPDIR/infra/catalog"
cat > "$TMPROOT/catpath.sh" <<EOF
#!/usr/bin/env bash
echo "\$COGNI_CATALOG_ROOT" >> "$ORDER"
EOF
chmod +x "$TMPROOT/catpath.sh"
: > "$ORDER"
( cd "$TMPROOT" && \
  COGNI_CATALOG_ROOT="infra/catalog" APP_SOURCE_DIR="$APPDIR" \
  RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/catpath.sh" \
  RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/catpath.sh" \
    bash "$RUNNER" candidate-a node-template >/dev/null )
seen_root="$(head -1 "$ORDER")"
case "$seen_root" in
  /*) [ -d "$seen_root" ] || { echo "normalized COGNI_CATALOG_ROOT not a real dir: $seen_root" >&2; exit 1; } ;;
  *) echo "COGNI_CATALOG_ROOT must be exported ABSOLUTE to callees; got: $seen_root" >&2; exit 1 ;;
esac

echo "PASS: run-node-substrate.test.sh"
