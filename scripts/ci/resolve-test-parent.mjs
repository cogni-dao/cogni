#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/resolve-test-parent`
 * Purpose: Print the `role: test-parent` artifact's repository and GitHub App binding as GitHub Actions outputs.
 * Scope: Policy lookup kept OUT of workflow YAML; does not clone or sync.
 * Invariants:
 *   - MANIFEST_IS_SSOT: target repository and allowed App identity have one declaration.
 *   - OWNER_APP_BOUNDARY_FAILS_CLOSED: a test parent without an explicit App ID + slug is invalid;
 *     the workflow never falls back to an environment's generic App ID.
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
if (!target.github_app?.id || !target.github_app?.slug) {
  console.error(
    "the `role: test-parent` artifact must declare github_app.id + github_app.slug"
  );
  process.exit(1);
}
const [owner, repo] = target.repo.split("/");
console.log(`owner=${owner}`);
console.log(`repo=${repo}`);
console.log(`full=${target.repo}`);
console.log(`app_id=${target.github_app.id}`);
console.log(`app_slug=${target.github_app.slug}`);
