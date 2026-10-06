#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
set -euo pipefail

[[ "${OPERATOR_CHANGE_OPERATION:-}" == deployment.declare ]] || exit 1
[[ "${OPERATOR_CHANGE_NODE:-}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || exit 1
[[ "${OPERATOR_CHANGE_BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "${OPERATOR_CHANGE_HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ -f "${OPERATOR_CHANGE_PATHS_FILE:-}" ]] || exit 1
[[ -f "${OPERATOR_CHANGE_DEPLOYMENT_FIXTURE:-}" ]] || exit 1
[[ "$(wc -l < "$OPERATOR_CHANGE_PATHS_FILE" | tr -d ' ')" == 1 ]] || exit 1
[[ "$(<"$OPERATOR_CHANGE_PATHS_FILE")" == .cogni/repo-spec.yaml ]] || exit 1

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
base_spec="$tmpdir/base.yaml"
head_spec="$tmpdir/head.yaml"
expected_spec="$tmpdir/expected.yaml"
git show "$OPERATOR_CHANGE_BASE_SHA:.cogni/repo-spec.yaml" > "$base_spec" 2>/dev/null || exit 1
git show "$OPERATOR_CHANGE_HEAD_SHA:.cogni/repo-spec.yaml" > "$head_spec" 2>/dev/null || exit 1

# The writer is a no-op when any top-level declaration already exists, so a
# changed PR with one in its base can never be the stock activation splice.
! grep -q '^deployment:' "$base_spec" || exit 1

node - "$base_spec" "$expected_spec" "$OPERATOR_CHANGE_DEPLOYMENT_FIXTURE" <<'NODE'
const fs = require("node:fs");
const [basePath, expectedPath, fixturePath] = process.argv.slice(2);
let base = fs.readFileSync(basePath, "utf8");
while (base.endsWith("\n")) base = base.slice(0, -1);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
if (typeof fixture.yaml !== "string" || !fixture.yaml.startsWith("deployment:\n")) {
  process.exit(1);
}
fs.writeFileSync(expectedPath, `${base}\n\n${fixture.yaml}`);
NODE

cmp -s "$expected_spec" "$head_spec"
