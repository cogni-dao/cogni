// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/deployment-activation`
 * Purpose: Pure splice of the stock `cogni-node-app-v1` `deployment:` declaration into an EXISTING
 *   node repo-spec YAML text. Existing nodes predate the deployment contract and ride the legacy
 *   secret-free default, which external-compute placement refuses (`assertDeclaredNodeDeployment`);
 *   the operator mints this block back into the node's OWN repo — never hand-edited YAML.
 * Scope: Pure string transform over the current `.cogni/repo-spec.yaml` text. No IO, no env, no
 *   YAML round-trip of the existing content (a string append, so the spec's comments + ordering are
 *   preserved byte-exact). The route layer reads the current file via the App and persists the
 *   result via a PR.
 * Invariants:
 *   - SCAFFOLD_AND_GATE_SHARE_ONE_VALUE: the appended block is `renderNodeDeploymentYaml()` — the
 *     SAME constant the node scaffold emits and the external-compute gate requires, so they cannot
 *     drift.
 *   - NEVER_OVERWRITE_A_DECLARATION: a spec that already carries ANY top-level `deployment:` block
 *     (a node's own hand-authored declaration included) splices to itself.
 *   - IDEMPOTENT_SPLICE: re-splicing an already-spliced spec is a byte-exact no-op.
 * Side-effects: none
 * Links: packages/repo-spec/src/node-app-deployment.ts, packages/repo-spec/src/accessors.ts
 *   (hasDeclaredNodeDeployment), task.5083, story.5016
 * @public
 */

import { parse as parseYaml } from "yaml";

import { renderNodeDeploymentYaml } from "./node-app-deployment.js";

/**
 * Match a top-level `deployment:` key (column 0). Fallback presence probe for text that does not
 * parse as YAML — the splicer must NEVER append a second block, even onto a corrupt spec.
 */
const TOP_LEVEL_DEPLOYMENT_KEY = /(^|\n)deployment:/;

/**
 * Semantic guard: does this repo-spec TEXT already declare a top-level `deployment:` block?
 *
 * Text-level sibling of `hasDeclaredNodeDeployment` (which takes a parsed `RepoSpec`) for the
 * PR-writer path, where an already-open activation branch may carry a correct declaration with
 * non-byte-identical whitespace. Returns false on unparseable text.
 */
export function hasDeploymentActivationSpec(spec: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseYaml(spec);
  } catch {
    return false;
  }
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).deployment !== undefined
  );
}

/**
 * Splice the stock `cogni-node-app-v1` `deployment:` declaration into an existing repo-spec YAML
 * string.
 *
 * Strategy (string append, comment-preserving):
 *   - Block present (parsed OR matched textually at column 0): return the input unchanged — a
 *     node's own declaration is never overwritten.
 *   - Block absent: append `renderNodeDeploymentYaml()` as a new top-level block after the
 *     existing content, separated by one blank line.
 *
 * The result is deterministic + idempotent: re-splicing the output returns it byte-exact.
 */
export function renderDeploymentActivationSpec(current: string): string {
  if (
    hasDeploymentActivationSpec(current) ||
    TOP_LEVEL_DEPLOYMENT_KEY.test(current)
  ) {
    return current;
  }
  return `${current.replace(/\n*$/, "\n")}\n${renderNodeDeploymentYaml()}`;
}
