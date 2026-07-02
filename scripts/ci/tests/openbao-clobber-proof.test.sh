#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Regression test for bug.5068 — the prod-outage clobber bug (2026-07-02).
#
# `cogni/<env>/<service>` is a SHARED multi-key OpenBao bucket. `bao kv put`
# REPLACES the whole bucket; `bao kv patch` merges. The buggy pattern chose
# put/patch off a `kv metadata get` precheck that conflated a TRANSIENT failure
# with "path absent" — a transient failure against a populated bucket did a `put`
# and wiped ~35 sibling secrets (DATABASE_URL, AUTH_SECRET, …) → ESO synced the
# emptied bucket → operator crashloop → ~1h prod 502.
#
# The fix (shared by scripts/secrets/set-secret.sh, scripts/ci/deploy-infra.sh
# patch_operator_openfga_config, scripts/ci/secret-materialize.sh flush_batch,
# scripts/setup/provision-env-vm.sh seed_kv):
#   patch FIRST → put ONLY on a POSITIVE "does not exist" signal → any other
#   (transient) error returns non-zero WITHOUT a put.
#
# This test drives scripts/secrets/set-secret.sh through its REAL bao codepath
# (BAO_ADDR/BAO_TOKEN set, no SET_SECRET_BAO shim) with a stub `bao` on PATH that
# models a KV backend + injectable transient faults. It proves, on the shared
# clobber-proof primitive:
#   (a) existing bucket   → patch merges, siblings preserved, NO put
#   (b) transient error   → NO put, non-zero exit (fail-closed)
#   (c) genuinely absent  → put (create), exit 0
#
# Run: bash scripts/ci/tests/openbao-clobber-proof.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/scripts/secrets/set-secret.sh"

TMPROOT=$(mktemp -d -t openbao-clobber.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

# ── Stub `bao` ──────────────────────────────────────────────────────────────
# Models a KV v2 backend as a directory tree: $BAO_STORE/<path-with-_>/<KEY>.
# Honors these env knobs (set per-case):
#   BAO_FAULT=patch  → `kv patch` fails as a TRANSIENT error (rc=2, no "absent"
#                      wording) even if the path exists — simulates the exec/
#                      network flake that caused the outage.
# Behavior:
#   kv patch <path> KEY=-  → if path dir missing, print "No value found" + rc 2
#                            (this is the POSITIVE absent signal); else merge stdin
#                            value into the existing keys (preserve siblings).
#   kv put   <path> KEY=-  → REPLACE the whole path with only the given key(s).
#   metadata get <path>    → rc 0 iff path dir exists (kept for completeness).
STUB="$TMPROOT/bin/bao"
mkdir -p "$TMPROOT/bin"
cat >"$STUB" <<'STUBEOF'
#!/usr/bin/env bash
set -euo pipefail
store="${BAO_STORE:?BAO_STORE unset}"
sanitize() { printf '%s' "$1" | tr '/' '_'; }

sub="$1"; shift
case "$sub" in
  kv)
    op="$1"; shift
    case "$op" in
      metadata)
        # metadata get <path>
        [[ "$1" == "get" ]] && shift
        d="$store/$(sanitize "$1")"
        [[ -d "$d" ]] && exit 0 || { echo "No value found at $1" >&2; exit 2; }
        ;;
      patch|put)
        path="$1"; shift
        d="$store/$(sanitize "$path")"
        # collect KEY=- assignments; value(s) via stdin (single key in these tests)
        declare -a keys=()
        for a in "$@"; do keys+=("${a%%=*}"); done
        value="$(cat)"
        if [[ "$op" == "patch" ]]; then
          if [[ "${BAO_FAULT:-}" == "patch" ]]; then
            # TRANSIENT failure — NOT an "absent" signal.
            echo "Error making API request: connection refused" >&2
            exit 2
          fi
          if [[ ! -d "$d" ]]; then
            # Positive "does not exist" — the ONLY case a put is safe.
            echo "No value found at $path" >&2
            exit 2
          fi
          # merge: keep existing keys, add/overwrite the given ones
          for k in "${keys[@]}"; do printf '%s' "$value" > "$d/$k"; done
          echo "merged"
          exit 0
        else
          # put: REPLACE the whole path
          rm -rf "$d"; mkdir -p "$d"
          for k in "${keys[@]}"; do printf '%s' "$value" > "$d/$k"; done
          echo "put"
          exit 0
        fi
        ;;
      *) echo "stub: unsupported kv op $op" >&2; exit 99 ;;
    esac
    ;;
  *) echo "stub: unsupported subcommand $sub" >&2; exit 99 ;;
esac
STUBEOF
chmod +x "$STUB"

STORE="$TMPROOT/store"
mkdir -p "$STORE"

pass=0
fail=0

check() {
  local name="$1" cond="$2"
  if eval "$cond"; then
    printf 'OK  %s\n' "$name"; pass=$((pass + 1))
  else
    printf 'FAIL %s  (cond: %s)\n' "$name" "$cond"; fail=$((fail + 1))
  fi
}

# set_secret <fault> <env> <service> <KEY> <value> ; sets global RC + OUT
set_secret() {
  local fault="$1"; shift
  local envn="$1" svc="$2" key="$3" val="$4"
  RC=0
  # shellcheck disable=SC2034  # OUT is consumed by check()'s eval'd conditions.
  OUT=$(printf '%s' "$val" | env \
    PATH="$TMPROOT/bin:$PATH" \
    BAO_STORE="$STORE" BAO_FAULT="$fault" \
    BAO_ADDR="http://127.0.0.1:8200" BAO_TOKEN="test-token" \
    REPO_ROOT="$REPO_ROOT" \
    bash "$TARGET" "$envn" "$svc" "$key" 2>&1) || RC=$?
}

path_dir() { printf '%s/cogni_candidate-a_%s' "$STORE" "$1"; }

# ── (c) genuinely absent → put (create) ──────────────────────────────────────
# Seed a sibling first so we can later prove (a) preserves it. Absent path:
set_secret "" candidate-a node-template SIBLING_ONE seed-value-1
check "(c) absent path → create succeeds (exit 0)" "[[ $RC -eq 0 ]]"
check "(c) key written on create" \
  "[[ \"\$(cat \"$(path_dir node-template)/SIBLING_ONE\" 2>/dev/null)\" == seed-value-1 ]]"

# ── (a) existing bucket → patch merges, siblings preserved, NO clobber ────────
set_secret "" candidate-a node-template SECOND_KEY second-value
check "(a) patch on existing path succeeds (exit 0)" "[[ $RC -eq 0 ]]"
check "(a) new key present after patch" \
  "[[ \"\$(cat \"$(path_dir node-template)/SECOND_KEY\" 2>/dev/null)\" == second-value ]]"
check "(a) SIBLING PRESERVED after patch (no clobber)" \
  "[[ \"\$(cat \"$(path_dir node-template)/SIBLING_ONE\" 2>/dev/null)\" == seed-value-1 ]]"

# ── (b) transient error → NO put, non-zero exit (fail-closed) ────────────────
# Path exists + patch injected to fail transiently. The bug would put→clobber.
set_secret patch candidate-a node-template THIRD_KEY third-value
check "(b) transient patch failure → non-zero exit" "[[ $RC -ne 0 ]]"
check "(b) THIRD_KEY NOT written (no put on transient)" \
  "[[ ! -e \"$(path_dir node-template)/THIRD_KEY\" ]]"
check "(b) SIBLINGS INTACT after transient failure (no clobber)" \
  "[[ \"\$(cat \"$(path_dir node-template)/SIBLING_ONE\" 2>/dev/null)\" == seed-value-1 && \"\$(cat \"$(path_dir node-template)/SECOND_KEY\" 2>/dev/null)\" == second-value ]]"
check "(b) refuses with an explanatory 'refusing to put' message" \
  "printf '%s' \"\$OUT\" | grep -qi 'refusing to put'"

echo
echo "openbao-clobber-proof.test.sh — pass: $pass, fail: $fail"
[[ $fail -eq 0 ]] || exit 1
