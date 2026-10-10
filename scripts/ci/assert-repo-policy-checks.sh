#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Assert that an exact commit has every check named by .cogni/repo-policy.json
# completed successfully. Used before both governed tag creation and publication
# so an ungated tag is never created and a tag cannot bypass the same policy.

set -euo pipefail

COMMIT_SHA="${1:?usage: assert-repo-policy-checks.sh <commit-sha>}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

gh api --paginate \
  "repos/${GITHUB_REPOSITORY}/commits/${COMMIT_SHA}/check-runs?per_page=100" \
  --jq '.check_runs[] | {name, status, conclusion}' > /tmp/check-runs.ndjson

COMMIT_SHA="$COMMIT_SHA" node - <<'NODE'
const fs = require("node:fs");

const policy = JSON.parse(
  fs.readFileSync(".cogni/repo-policy.json", "utf8")
);
const required = policy?.ruleset?.requiredStatusChecks?.contexts ?? [];
if (required.length === 0) {
  console.error(
    "repo-policy declares no required checks - refusing to release ungated bytes"
  );
  process.exit(1);
}

const runs = fs
  .readFileSync("/tmp/check-runs.ndjson", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const problems = [];
for (const context of required) {
  const matching = runs.filter((run) => run.name === context);
  if (matching.length === 0) {
    problems.push(`${context}: never reported on this commit`);
    continue;
  }
  const passed = matching.some(
    (run) => run.status === "completed" && run.conclusion === "success"
  );
  if (!passed) {
    const seen = matching
      .map((run) => `${run.status}/${run.conclusion}`)
      .join(", ");
    problems.push(`${context}: ${seen}`);
  }
}

if (problems.length > 0) {
  console.error(
    `refusing to release: required checks not green on ${process.env.COMMIT_SHA}`
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `all ${required.length} required checks green on ${process.env.COMMIT_SHA}`
);
NODE
