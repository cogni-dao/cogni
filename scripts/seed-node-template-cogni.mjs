#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/seed-node-template-cogni`
 * Purpose: Project the canonical node-template review policy (`nodes/node-template/.cogni/rules/*`
 *   + the node-scoped AGENTS.md template) onto the standalone node-at-root `node-template` repo the
 *   wizard mints from (`generate-from-template`), so every minted node is BORN_REVIEWABLE. This is
 *   the `.cogni` + CI slice of the node-at-root sub-tree projection — the rule files and
 *   workflow ride into mints verbatim (generate-from-template copies the template repo),
 *   while the gates themselves are re-emitted by `renderRepoSpec`. Keep both in lockstep.
 * Scope: Projects only the review-policy/build slice (rules + AGENTS + node CI) — does not
 *   modify the operator monorepo tree and does not run the mint flow. Re-roots
 *   `nodes/node-template/.cogni/rules/` → `<repo>/.cogni/rules/`, writes the AGENTS template to
 *   `<repo>/AGENTS.md`, and writes the node-at-root CI workflow to
 *   `<repo>/.github/workflows/ci.yaml`; reports drift by default, `--apply` commits + pushes to
 *   the template main.
 * Invariants: idempotent — a no-drift run is a no-op; never touches the operator monorepo tree.
 * Side-effects: IO (clones into /tmp; with `--apply`, commits + pushes to the target repo via gh auth).
 * Notes: Run after this PR is flighted, then re-mint a node and confirm a real review (not "no gates").
 * Links: nodes/node-template/.cogni/rules/, nodes/operator/app/src/shared/node-app-scaffold/gens/repo-spec.ts, docs/spec/node-ci-cd-contract.md
 * @public
 */

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_REPO = process.env.TEMPLATE_REPO ?? "Cogni-DAO/node-template";
const APPLY = process.argv.includes("--apply");

const CANONICAL_RULES = join(HUB_ROOT, "nodes/node-template/.cogni/rules");
const AGENTS_TMPL = join(HUB_ROOT, "nodes/node-template/.cogni/AGENTS.tmpl.md");
const NODE_CI_WORKFLOW = join(
  HUB_ROOT,
  "nodes/node-template/.github/workflows/ci.yaml"
);
const dest = join("/tmp", `seed-${TEMPLATE_REPO.replace("/", "_")}`);

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
execSync(
  `git clone --depth 1 --quiet https://github.com/${TEMPLATE_REPO}.git ${dest}`,
  {
    stdio: ["ignore", "pipe", "inherit"],
  }
);

mkdirSync(join(dest, ".cogni/rules"), { recursive: true });
cpSync(CANONICAL_RULES, join(dest, ".cogni/rules"), { recursive: true });
writeFileSync(join(dest, "AGENTS.md"), readFileSync(AGENTS_TMPL, "utf8"));
mkdirSync(join(dest, ".github/workflows"), { recursive: true });
writeFileSync(
  join(dest, ".github/workflows/ci.yaml"),
  readFileSync(NODE_CI_WORKFLOW, "utf8")
);

const status = execSync(`git -C "${dest}" status --porcelain`, {
  encoding: "utf8",
}).trim();
if (!status) {
  console.log(`✓ ${TEMPLATE_REPO} already in lockstep — no drift.`);
  process.exit(0);
}

console.log(`drift on ${TEMPLATE_REPO}:\n${status}`);
if (!APPLY) {
  console.log("\n(run with --apply to commit + push)");
  process.exit(0);
}

execSync(
  `git -C "${dest}" add .cogni/rules AGENTS.md .github/workflows/ci.yaml`,
  {
    stdio: "inherit",
  }
);
execSync(
  `git -C "${dest}" commit -m "chore(node-template): sync review policy and ci workflow from hub"`,
  { stdio: "inherit" }
);
execSync(`git -C "${dest}" push origin HEAD:main`, { stdio: "inherit" });
console.log(`✓ pushed born-reviewable policy to ${TEMPLATE_REPO}`);
