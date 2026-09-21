#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/resolve-test-parent`
 * Purpose: Print the `role: test-parent` artifact's `owner=` / `repo=` as GitHub Actions outputs.
 * Scope: One line of policy lookup, kept OUT of workflow YAML so the mirror's identity has exactly
 *   one home (.cogni/sync-manifest.yaml) and the workflow never hardcodes an owner/repo.
 * Invariants: MANIFEST_IS_SSOT — a workflow that inlined `cogni-test-org/cogni-monorepo` would be a
 *   second declaration of the target, which is the drift class this whole contract exists to kill.
 * Side-effects: IO (reads the manifest); prints `key=value` lines to stdout; exits non-zero when no
 *   artifact declares the role.
 * Links: .cogni/sync-manifest.yaml, .github/workflows/test-parent-sync.yml, scripts/ci/sync-test-parent.mjs
 * @public
 */

import { join } from "node:path";
import { readManifest } from "./lib/sync-policy.mjs";

const manifest = readManifest(
  join(process.env.HUB_DIR ?? process.cwd(), ".cogni/sync-manifest.yaml")
);
const target = manifest.artifacts.find((a) => a.role === "test-parent");
if (!target) {
  console.error(
    "no artifact in .cogni/sync-manifest.yaml declares `role: test-parent`"
  );
  process.exit(1);
}
const [owner, repo] = target.repo.split("/");
console.log(`owner=${owner}`);
console.log(`repo=${repo}`);
console.log(`full=${target.repo}`);
