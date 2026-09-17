#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Proves the per-node substrate runner wires materialize → reconcile uniformly:
#   - both callees run, in order, with the SAME (env, node) args;
#   - every provider reconciles placement-neutral state before provider assertion;
#   - reconcile runs ONLY after materialize succeeds (fail-fast on materialize);
#   - exit code propagates (a failing callee fails the runner).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_ROOT/scripts/ci/run-node-substrate.sh"

TMPROOT=$(mktemp -d -t run-node-substrate.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
ORDER="$TMPROOT/order.log"

# Every case needs a catalog row: the runner resolves WHICH VAULT owns a lane's secrets from
# it, and refuses to guess when it is absent (bug.5206).
CATALOG_FIXTURE="$TMPROOT/catalog"
mkdir -p "$CATALOG_FIXTURE"
export COGNI_CATALOG_ROOT="$CATALOG_FIXTURE"
for n in node-template operator toks4 k3snode; do
  printf 'name: %s\nenvs: [candidate-a, preview, production]\n' "$n" > "$CATALOG_FIXTURE/$n.yaml"
done
# toks4 is akash in PRODUCTION ONLY — control env == env in every lane it holds, which is
# every existing fleet row. Case 5 must stay byte-identical to its pre-bug.5206 expectation.
printf 'name: toks4\nenvs: [production]\ndeployment_provider:\n  production: akash\n' > "$CATALOG_FIXTURE/toks4.yaml"
cat > "$CATALOG_FIXTURE/polyfix.yaml" <<'YAML'
name: polyfix
envs: [candidate-a, preview, production]
deployment_provider:
  candidate-a: akash
  preview: akash
  production: akash
YAML

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
cp "$CATALOG_FIXTURE"/*.yaml "$APPDIR/infra/catalog/"
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

# ── Case 5: external compute gets the SAME placement-neutral reconcile/DB
#    provisioning before its provider assert. Provider is supplied by the typed map. ─
mk_stub "$TMPROOT/mat.sh" materialize 0
cat > "$TMPROOT/rec.sh" <<EOF
#!/usr/bin/env bash
echo "reconcile \$1 \$2 provider=\${DEPLOYMENT_PROVIDER:-unset}" >> "$ORDER"
EOF
chmod +x "$TMPROOT/rec.sh"
mk_stub "$TMPROOT/assert.sh" assert 0
: > "$ORDER"
DEPLOYMENT_PROVIDER=akash \
RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/mat.sh" \
RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/rec.sh" \
RUN_NODE_SUBSTRATE_ASSERT_BIN="$TMPROOT/assert.sh" \
  bash "$RUNNER" production toks4 >/dev/null
got="$(paste -sd'|' - < "$ORDER")"
want="materialize production toks4|reconcile production toks4 provider=akash|assert production toks4"
[ "$got" = "$want" ] || { echo "external phase mismatch:
  got:  $got
  want: $want" >&2; exit 1; }

# ── Case 6: SECRETS FOLLOW THE RECONCILING CLUSTER, DB SUBSTRATE FOLLOWS THE ENV.
#    bug.5206. An akash node's non-production lane is reconciled by the production cluster,
#    so its secrets belong in THAT vault. The flight running against the lane's OWN VM must
#    decline the materialize + secret-bank assert it cannot legitimately make — and must
#    STILL reconcile, because the workload dials this env's substrate host. ─────────────
mk_stub "$TMPROOT/mat.sh" materialize 0
mk_stub "$TMPROOT/rec.sh" reconcile 0
mk_stub "$TMPROOT/assert.sh" assert 0
: > "$ORDER"
DEPLOYMENT_PROVIDER=akash COGNI_CATALOG_ROOT="$CATALOG_FIXTURE" \
RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/mat.sh" \
RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/rec.sh" \
RUN_NODE_SUBSTRATE_ASSERT_BIN="$TMPROOT/assert.sh" \
  bash "$RUNNER" candidate-a polyfix >/dev/null
# A foreign-custodied lane has NO substrate on its own VM: the vault bank, the database, the
# roles and the Temporal namespace all belong to the control cluster and are provisioned by
# THAT cluster's run. Reconciling here mints `<control>-db-reader` against the LANE's OpenBao,
# where it does not exist, and kills the flight. Doing nothing is the correct amount of work.
got="$(paste -sd'|' - < "$ORDER")"
want=""
[ "$got" = "$want" ] || { echo "a foreign-custodied lane's own flight must touch NOTHING on its own VM:
  got:  $got
  want: <nothing>" >&2; exit 1; }

# ── Case 7: the control env writes its OWN secrets AND every lane it reconciles. ─────
: > "$ORDER"
DEPLOYMENT_PROVIDER=akash COGNI_CATALOG_ROOT="$CATALOG_FIXTURE" \
RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/mat.sh" \
RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/rec.sh" \
RUN_NODE_SUBSTRATE_ASSERT_BIN="$TMPROOT/assert.sh" \
  bash "$RUNNER" production polyfix >/dev/null
got="$(paste -sd'|' - < "$ORDER")"
# The control env materializes AND reconciles every lane it custodies: a lane whose secrets
# exist but whose DATABASE does not yields a lease that boots, cannot connect, and is closed
# by the boot deadline (task.5132).
want="materialize production polyfix|materialize candidate-a polyfix|materialize preview polyfix|reconcile production polyfix|reconcile candidate-a polyfix|reconcile preview polyfix|assert production polyfix"
[ "$got" = "$want" ] || { echo "the reconciling cluster must hold every lane it reconciles:
  got:  $got
  want: $want" >&2; exit 1; }

# ── Case 8: ZERO BLAST RADIUS. A k3s row's lanes each live in their own cluster, so the
#    control env is the env and nothing above changes — the pre-bug.5206 behaviour exactly. ─
: > "$ORDER"
COGNI_CATALOG_ROOT="$CATALOG_FIXTURE" \
RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/mat.sh" \
RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/rec.sh" \
  bash "$RUNNER" production k3snode >/dev/null
got="$(paste -sd'|' - < "$ORDER")"
want="materialize production k3snode|reconcile production k3snode"
[ "$got" = "$want" ] || { echo "a k3s row must be untouched by the control-env split:
  got:  $got
  want: $want" >&2; exit 1; }

echo "PASS: run-node-substrate.test.sh"
