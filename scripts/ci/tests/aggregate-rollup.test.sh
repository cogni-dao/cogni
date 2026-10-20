#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t aggregate-rollup.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

# The rollup reader derives overlay custody from its own script location. Copy that
# existing reader and its library into a test tree with both authored overlay cells.
FIXTURE_SOURCE="$TMPROOT/source"
mkdir -p "$FIXTURE_SOURCE/scripts/ci/lib" "$FIXTURE_SOURCE/infra/k8s/overlays/production/operator" \
  "$FIXTURE_SOURCE/infra/k8s/overlays/production/poly"
cp "$REPO_ROOT/scripts/ci/aggregate-rollup.sh" "$FIXTURE_SOURCE/scripts/ci/"
cp "$REPO_ROOT/scripts/ci/lib/"*.sh "$FIXTURE_SOURCE/scripts/ci/lib/"
. "$SCRIPT_DIR/fixtures/catalog.sh"
write_akash_catalog_fixture "$FIXTURE_SOURCE/infra/catalog" operator
write_akash_catalog_fixture "$FIXTURE_SOURCE/infra/catalog" poly

REMOTE="$TMPROOT/origin.git"
WORK="$TMPROOT/work"
git init --bare "$REMOTE" >/dev/null
git init "$WORK" >/dev/null
git -C "$WORK" config user.name test
git -C "$WORK" config user.email test@example.test

mkdir -p "$WORK/.promote-state"
printf '{}\n' > "$WORK/.promote-state/source-sha-by-app.json"
printf 'base\n' > "$WORK/README.md"
git -C "$WORK" add .
git -C "$WORK" commit -m "base" >/dev/null
common_base=$(git -C "$WORK" rev-parse HEAD)
git -C "$WORK" branch -M main
git -C "$WORK" remote add origin "$REMOTE"
git -C "$WORK" push origin main >/dev/null

git -C "$WORK" switch -c deploy/production >/dev/null
printf '{}\n' > "$WORK/.promote-state/source-sha-by-app.json"
printf 'seed\n' > "$WORK/.promote-state/current-sha"
git -C "$WORK" add .
git -C "$WORK" commit -m "seed production rollup" >/dev/null
git -C "$WORK" push origin deploy/production >/dev/null

git -C "$WORK" switch -c deploy/production-operator main >/dev/null
mkdir -p "$WORK/.promote-state"
printf '{"operator":"6859ead900b33e4c3684f2c330b01ec5c790b73f"}\n' > "$WORK/.promote-state/source-sha-by-app.json"
git -C "$WORK" add .
git -C "$WORK" commit -m "seed operator production cell" >/dev/null
operator_tip=$(git -C "$WORK" rev-parse HEAD)
git -C "$WORK" push origin deploy/production-operator >/dev/null

ROLLUP_TARGETS_JSON='["operator"]' \
  REPO_URL="file://$REMOTE" \
  GH_TOKEN=dummy \
  GITHUB_REPOSITORY=Cogni-DAO/cogni \
  bash "$FIXTURE_SOURCE/scripts/ci/aggregate-rollup.sh" production > "$TMPROOT/out.log" 2>&1

current_sha=$(git --git-dir="$REMOTE" show deploy/production:.promote-state/current-sha)
if [ "$current_sha" != "$operator_tip" ]; then
  echo "[FAIL] expected single-target current-sha $operator_tip, got $current_sha"
  cat "$TMPROOT/out.log"
  exit 1
fi

mapped_sha=$(git --git-dir="$REMOTE" show deploy/production:.promote-state/source-sha-by-app.json | jq -r '.operator')
if [ "$mapped_sha" != "6859ead900b33e4c3684f2c330b01ec5c790b73f" ]; then
  echo "[FAIL] expected operator source-sha map entry, got $mapped_sha"
  cat "$TMPROOT/out.log"
  exit 1
fi

if ! grep -q "Pushed on attempt" "$TMPROOT/out.log"; then
  echo "[FAIL] expected rollup push to succeed"
  cat "$TMPROOT/out.log"
  exit 1
fi

echo "[PASS] aggregate-rollup scopes to selected operator target"

# Real shallow clones must recover a common ancestor beyond both depth-50
# boundaries. commit-tree makes long, independent histories without costly IO.
operator_tree=$(git -C "$WORK" rev-parse "${operator_tip}^{tree}")
for ((i = 0; i < 75; i++)); do
  operator_tip=$(printf 'operator promotion %s\n' "$i" | git -C "$WORK" commit-tree "$operator_tree" -p "$operator_tip")
done
git -C "$WORK" update-ref refs/heads/deploy/production-operator "$operator_tip"
git -C "$WORK" switch -c deploy/production-poly main >/dev/null
printf '{"poly":"1111111111111111111111111111111111111111"}\n' > "$WORK/.promote-state/source-sha-by-app.json"
git -C "$WORK" add .
git -C "$WORK" commit -m "seed poly production cell" >/dev/null
poly_tip=$(git -C "$WORK" rev-parse HEAD)
poly_tree=$(git -C "$WORK" rev-parse 'HEAD^{tree}')
for ((i = 0; i < 75; i++)); do
  poly_tip=$(printf 'poly promotion %s\n' "$i" | git -C "$WORK" commit-tree "$poly_tree" -p "$poly_tip")
done
git -C "$WORK" update-ref refs/heads/deploy/production-poly "$poly_tip"
git -C "$WORK" push origin deploy/production-operator deploy/production-poly >/dev/null

ROLLUP_TARGETS_JSON='["operator","poly"]' \
  REPO_URL="file://$REMOTE" \
  GH_TOKEN=dummy \
  GITHUB_REPOSITORY=Cogni-DAO/cogni \
  bash "$FIXTURE_SOURCE/scripts/ci/aggregate-rollup.sh" production > "$TMPROOT/deep.log" 2>&1 || {
    cat "$TMPROOT/deep.log"
    exit 1
  }

actual_base=$(git --git-dir="$REMOTE" show deploy/production:.promote-state/current-sha)
if [ "$actual_base" != "$common_base" ]; then
  echo "[FAIL] expected historical common ancestor $common_base, got $actual_base"
  cat "$TMPROOT/deep.log"
  exit 1
fi
map=$(git --git-dir="$REMOTE" show deploy/production:.promote-state/source-sha-by-app.json)
if ! printf '%s' "$map" | jq -e '.operator == "6859ead900b33e4c3684f2c330b01ec5c790b73f" and .poly == "1111111111111111111111111111111111111111"' >/dev/null; then
  echo "[FAIL] expected both source map entries after history recovery"
  exit 1
fi
if ! grep -q 'Deepening production deployment histories' "$TMPROOT/deep.log"; then
  echo "[FAIL] fixture did not exercise shallow-history recovery"
  exit 1
fi
echo "[PASS] aggregate-rollup deepens independent promotion histories to the real common ancestor"
