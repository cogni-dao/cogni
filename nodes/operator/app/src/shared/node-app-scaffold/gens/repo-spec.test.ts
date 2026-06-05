// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/repo-spec`
 * Purpose: Pin BORN_REVIEWABLE — the minted `.cogni/repo-spec.yaml` must carry the default review
 *   gates, and every ai-rule it references must exist as a canonical rule file in
 *   `nodes/node-template/.cogni/rules/` (lockstep with the files generate-from-template ships).
 * Scope: Pure unit test over `renderRepoSpec` output + the canonical rules dir on disk; does not
 *   exercise the mint network path.
 * Invariants: minted spec has gates, has no `nodes:` registry (single-node-fork signal), and its
 *   ai-rule `rule_file`s all resolve to shipped rule files.
 * Side-effects: IO (reads the canonical rules dir).
 * Links: src/shared/node-app-scaffold/gens/repo-spec, nodes/node-template/.cogni/rules/
 * @public
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { renderRepoSpec } from "./repo-spec";

/** Walk up from this file to the repo root (the dir holding pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root (pnpm-workspace.yaml) not found");
}

const RULES_DIR = join(repoRoot(), "nodes/node-template/.cogni/rules");

const rendered = renderRepoSpec({
  nodeId: "11111111-2222-4333-8444-555555555555",
  chainId: 8453,
  daoContract: "0xDAO",
  pluginContract: "0xPLUGIN",
  signalContract: "0xSIGNAL",
});

interface ParsedGate {
  type: string;
  with?: { rule_file?: string };
}
interface ParsedSpec {
  node_id: string;
  payments: { status: string };
  gates?: ParsedGate[];
  nodes?: unknown;
}

describe("renderRepoSpec — BORN_REVIEWABLE", () => {
  const spec = parseYaml(rendered) as ParsedSpec;
  const gates = spec.gates ?? [];

  it("is parseable identity + governance YAML", () => {
    expect(spec.node_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(spec.payments.status).toBe("pending_activation");
  });

  it("emits the default review gates so minted nodes are born-reviewable", () => {
    const types = gates.map((g) => g.type);
    expect(types).toContain("review-limits");
    expect(types.filter((t) => t === "ai-rule").length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("has NO `nodes:` registry — resolves as a single-node fork", () => {
    expect(spec.nodes).toBeUndefined();
  });

  it("references only ai-rule files that exist as canonical node-template rules", () => {
    const ruleFiles = gates
      .filter((g) => g.type === "ai-rule")
      .map((g) => g.with?.rule_file)
      .filter((rf): rf is string => typeof rf === "string");
    expect(ruleFiles.length).toBeGreaterThan(0);
    for (const rf of ruleFiles) {
      expect(existsSync(join(RULES_DIR, rf)), `missing rule file: ${rf}`).toBe(
        true
      );
    }
  });
});
