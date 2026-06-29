// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/repo-spec`
 * Purpose: Pin BORN_REVIEWABLE — the minted `.cogni/repo-spec.yaml` must carry the default review
 *   gates, and the ai-rule filenames must match the external node-template's inherited rules.
 * Scope: Pure unit test over `renderRepoSpec` output; does not exercise the mint network path.
 * Invariants: minted spec has gates, has no `nodes:` registry (single-node-fork signal), and its
 *   ai-rule `rule_file`s match the template contract.
 * Side-effects: none.
 * Links: src/shared/node-app-scaffold/gens/repo-spec, infra/catalog/node-template.yaml
 * @public
 */

import { parseRepoSpec } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { renderRepoSpec } from "./repo-spec";

const TEMPLATE_RULE_FILES = [
  "pr-syntropy-coherence.yaml",
  "patterns-and-docs.yaml",
  "repo-goal-alignment.yaml",
];

const rendered = renderRepoSpec({
  slug: "my-node",
  repoOwner: "cogni-dao-test",
  nodeId: "11111111-2222-4333-8444-555555555555",
  chainId: 8453,
  daoContract: "0x1111111111111111111111111111111111111111",
  pluginContract: "0x2222222222222222222222222222222222222222",
  signalContract: "0x3333333333333333333333333333333333333333",
  tokenContract: "0x4444444444444444444444444444444444444444",
  knowledgeRemote: {
    database: "knowledge_my_node",
    owner: "cogni-dao-test",
    repo: "knowledge-my-node",
    url: "https://doltremoteapi.dolthub.com/cogni-dao-test/knowledge-my-node",
  },
});

interface ParsedGate {
  type: string;
  with?: { rule_file?: string };
}
interface ParsedSpec {
  node_id: string;
  intent?: { name: string; mission?: string };
  activity_ledger?: {
    epoch_length_days: number;
    approvers: string[];
    activity_sources: {
      github?: {
        attribution_pipeline: string;
        source_refs: string[];
      };
    };
  };
  knowledge?: {
    database: string;
    remote: {
      provider: string;
      owner: string;
      repo: string;
      url: string;
      custody: string;
    };
  };
  payments: { status: string };
  distributions: { status: string };
  gates?: ParsedGate[];
  nodes?: unknown;
}

describe("renderRepoSpec — BORN_REVIEWABLE", () => {
  const spec = parseYaml(rendered) as ParsedSpec;
  const gates = spec.gates ?? [];

  it("is parseable identity + governance YAML", () => {
    expect(spec.node_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(spec.intent?.name).toBe("my-node");
    expect(spec.payments.status).toBe("pending_activation");
    expect(spec.distributions.status).toBe("pending_activation");
  });

  it("emits a starter intent.mission seed for the launch agent to refine", () => {
    expect(spec.intent?.mission).toBeTruthy();
    expect(spec.intent?.mission).toContain("my-node");
  });

  it("honours an explicit mission when provided", () => {
    const withMission = parseYaml(
      renderRepoSpec({
        slug: "my-node",
        repoOwner: "cogni-dao-test",
        nodeId: "11111111-2222-4333-8444-555555555555",
        chainId: 8453,
        mission: "Mirror Polymarket copy-trades for the DAO.",
      })
    ) as ParsedSpec;
    expect(withMission.intent?.mission).toBe(
      "Mirror Polymarket copy-trades for the DAO."
    );
  });

  it("keeps the node-template activity ledger so epoch ingest is active", () => {
    expect(spec.activity_ledger).toMatchObject({
      epoch_length_days: 7,
      activity_sources: {
        github: {
          attribution_pipeline: "cogni-v0.0",
          source_refs: ["cogni-dao-test/my-node"],
        },
      },
    });
    expect(spec.activity_ledger?.approvers).toContain(
      "0x070075F1389Ae1182aBac722B36CA12285d0c949"
    );
  });

  it("emits the default review gates so minted nodes are born-reviewable", () => {
    const types = gates.map((g) => g.type);
    expect(types).toContain("review-limits");
    expect(types.filter((t) => t === "ai-rule").length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("emits a parseable Cogni-owned DoltHub knowledge remote", () => {
    expect(() => parseRepoSpec(rendered)).not.toThrow();
    expect(spec.knowledge).toEqual({
      database: "knowledge_my_node",
      remote: {
        provider: "dolthub",
        owner: "cogni-dao-test",
        repo: "knowledge-my-node",
        url: "https://doltremoteapi.dolthub.com/cogni-dao-test/knowledge-my-node",
        custody: "cogni-owned",
      },
    });
  });

  it("has NO `nodes:` registry — resolves as a single-node fork", () => {
    expect(spec.nodes).toBeUndefined();
  });

  it("references the external node-template ai-rule set", () => {
    const ruleFiles = gates
      .filter((g) => g.type === "ai-rule")
      .map((g) => g.with?.rule_file)
      .filter((rf): rf is string => typeof rf === "string");
    expect(ruleFiles).toEqual(TEMPLATE_RULE_FILES);
  });
});
