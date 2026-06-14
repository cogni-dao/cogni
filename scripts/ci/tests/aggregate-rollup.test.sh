#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t aggregate-rollup.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

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
  bash scripts/ci/aggregate-rollup.sh production > "$TMPROOT/out.log" 2>&1

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
