#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# update-source-sha-map.sh — merge a single `app → source_sha` entry into
# .promote-state/source-sha-by-app.json on the deploy branch. Called once
# per promoted app by promote-build-payload.sh (candidate-a path) and by
# promote-and-deploy.yml's promote-k8s loop (preview / production path).
#
# The map is the artifact-provenance carrier for cross-env contract
# verification (bug.0321 Fix 4). verify-buildsha.sh reads it to assert
# each node's /version.buildSha matches the SHA that built that node's
# overlay digest — even when different nodes were built from different
# PR head SHAs (affected-only CI, cross-PR production promotions).
#
# Merges instead of overwriting: apps not promoted in this run retain
# their prior source_sha entry. Missing file bootstraps to {}.
#
# Env:
#   APP         (required) app name (operator | poly | resy | scheduler-worker | ...)
#   SOURCE_SHA  (required) full 40-char PR head SHA — lowercased for normalisation
#   MAP_FILE    (default .promote-state/source-sha-by-app.json) path relative
#               to cwd; caller must cd into the deploy-branch checkout first.
#   CATALOG_BIRTH_SHA (optional) the node's `source_sha` from infra/catalog/<app>.yaml.
#               When supplied, arms PIN_IS_NEVER_REPINNED_TO_BIRTH (bug.5306).
#
# PIN_IS_NEVER_REPINNED_TO_BIRTH (bug.5306). The catalog's `source_sha` is BIRTH
# METADATA, never deploy authority (bug.5237 / #2398). But
# detect-remote-source-artifact-targets.sh adds a remote-source node as a promote
# target whenever a changed path merely SELECTS it, pinned to that catalog value —
# so an unrelated operator promote silently dragged a node's lane back to its birth
# SHA. Observed on toks4: the preview pin oscillated between the birth SHA and the
# real repo HEAD six times, twice in one evening, on preview AND production, with
# every gate green (gates assert served==pinned, and after a revert both sides agree
# on the WRONG sha).
#
# The guard is deliberately NARROW so it can never fail a legitimate promote: it
# refuses ONLY when an existing pin is being replaced by exactly the catalog birth
# SHA. A forward promote, a first pin, a deliberate re-promote of the birth SHA on a
# lane that has no pin, and any caller that does not pass CATALOG_BIRTH_SHA are all
# untouched.

set -euo pipefail

APP="${APP:?APP required}"
SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"
MAP_FILE="${MAP_FILE:-.promote-state/source-sha-by-app.json}"
CATALOG_BIRTH_SHA="${CATALOG_BIRTH_SHA:-}"

mkdir -p "$(dirname "$MAP_FILE")"
if [ ! -f "$MAP_FILE" ]; then
  echo '{}' >"$MAP_FILE"
fi

python3 - "$MAP_FILE" "$APP" "$SOURCE_SHA" "$CATALOG_BIRTH_SHA" <<'PY'
import json
import sys

path, app, sha = sys.argv[1], sys.argv[2], sys.argv[3].lower()
birth = (sys.argv[4] if len(sys.argv) > 4 else "").lower()
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, json.JSONDecodeError):
    data = {}
if not isinstance(data, dict):
    data = {}
prior = data.get(app)
# PIN_IS_NEVER_REPINNED_TO_BIRTH (bug.5306) — refuse a silent rollback to birth metadata.
if birth and prior and prior.lower() != sha and sha == birth:
    sys.stderr.write(
        "::error::PIN_REGRESSION_REFUSED: refusing to re-pin "
        f"{app} from {prior[:8]} to the CATALOG BIRTH sha {sha[:8]}. "
        "Catalog source_sha is birth metadata, never deploy authority (bug.5237/#2398). "
        "This promote was not source-addressed for this node, so its existing lane pin stands. "
        "To move this lane deliberately, promote it with an explicit sourceSha.\n"
    )
    raise SystemExit(1)
data[app] = sha
with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, sort_keys=True)
    handle.write("\n")
print(f"  ↳ source-sha-by-app.json[{app}] = {sha[:8]}")
PY
