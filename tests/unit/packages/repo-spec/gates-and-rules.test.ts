// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/gates-and-rules`
 * Purpose: Unit tests for gates schema, rules schema, parseRule(), and extractGatesConfig().
 * Scope: Pure schema + function tests. Does not perform network I/O.
 * Invariants: Gate + rule schemas match existing .cogni/rules/*.yaml and repo-spec.yaml fixtures.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts, packages/repo-spec/src/rules.ts
 * @public
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractGatesConfig,
  gateConfigSchema,
  parseRepoSpec,
  parseRule,
  ruleSchema,
  successCriteriaSchema,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Per task.0410, rule files moved from root .cogni/rules/ → nodes/operator/.cogni/rules/.
const RULES_DIR = join(process.cwd(), "nodes", "operator", ".cogni", "rules");
const REPO_SPEC_PATH = join(process.cwd(), ".cogni", "repo-spec.yaml");

function readRuleFixture(filename: string): string {
  return readFileSync(join(RULES_DIR, filename), "utf-8");
}

// ---------------------------------------------------------------------------
// Rule schema tests
// ---------------------------------------------------------------------------

describe("ruleSchema", () => {
  it("validates a minimal rule", () => {
    const result = ruleSchema.safeParse({
      id: "test-rule",
      evaluations: [{ "test-metric": "Does this work?" }],
      success_criteria: {
        require: [{ metric: "test-metric", gte: 0.8 }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects rule without evaluations", () => {
    const result = ruleSchema.safeParse({
      id: "test-rule",
      evaluations: [],
      success_criteria: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects evaluation entry with multiple keys", () => {
    const result = ruleSchema.safeParse({
      id: "test-rule",
      evaluations: [{ "metric-a": "prompt a", "metric-b": "prompt b" }],
      success_criteria: {},
    });
    expect(result.success).toBe(false);
  });

  it("defaults blocking to true", () => {
    const result = ruleSchema.parse({
      id: "test-rule",
      evaluations: [{ "test-metric": "Does this work?" }],
      success_criteria: {},
    });
    expect(result.blocking).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Success criteria schema tests
// ---------------------------------------------------------------------------

describe("successCriteriaSchema", () => {
  it("validates require with gte operator", () => {
    const result = successCriteriaSchema.safeParse({
      require: [{ metric: "coherent-change", gte: 0.8 }],
    });
    expect(result.success).toBe(true);
  });

  it("validates any_of with multiple criteria", () => {
    const result = successCriteriaSchema.safeParse({
      any_of: [
        { metric: "follows-patterns", gte: 0.7 },
        { metric: "documents-new-patterns", gte: 0.7 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects threshold with no operator", () => {
    const result = successCriteriaSchema.safeParse({
      require: [{ metric: "test" }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults neutral_on_missing_metrics to false", () => {
    const result = successCriteriaSchema.parse({});
    expect(result.neutral_on_missing_metrics).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate config schema tests
// ---------------------------------------------------------------------------

describe("gateConfigSchema", () => {
  it("validates review-limits gate", () => {
    const result = gateConfigSchema.safeParse({
      type: "review-limits",
      id: "review_limits",
      with: { max_changed_files: 50, max_total_diff_kb: 1500 },
    });
    expect(result.success).toBe(true);
  });

  it("validates ai-rule gate", () => {
    const result = gateConfigSchema.safeParse({
      type: "ai-rule",
      with: { rule_file: "pr-syntropy-coherence.yaml" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown gate type", () => {
    const result = gateConfigSchema.safeParse({
      type: "unknown-gate",
      with: {},
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseRule() tests
// ---------------------------------------------------------------------------

describe("parseRule", () => {
  it("parses pr-syntropy-coherence.yaml fixture", () => {
    const yaml = readRuleFixture("pr-syntropy-coherence.yaml");
    const rule = parseRule(yaml);
    expect(rule.id).toBe("strict-pr-mapping");
    expect(rule.evaluations).toHaveLength(3);
    expect(rule.success_criteria.require).toHaveLength(3);
  });

  it("parses patterns-and-docs.yaml fixture", () => {
    const yaml = readRuleFixture("patterns-and-docs.yaml");
    const rule = parseRule(yaml);
    expect(rule.id).toBe("patterns-and-docs");
    expect(rule.evaluations).toHaveLength(2);
    expect(rule.success_criteria.any_of).toHaveLength(2);
  });

  it("parses repo-goal-alignment.yaml fixture", () => {
    const yaml = readRuleFixture("repo-goal-alignment.yaml");
    const rule = parseRule(yaml);
    expect(rule.id).toBe("cogni-git-review-repo-goal-alignment");
    expect(rule.evaluations).toHaveLength(4);
    expect(rule.success_criteria.any_of).toHaveLength(4);
  });

  it("parses pre-parsed object", () => {
    const rule = parseRule({
      id: "test",
      evaluations: [{ "test-metric": "Does it work?" }],
      success_criteria: { require: [{ metric: "test-metric", gte: 0.5 }] },
    });
    expect(rule.id).toBe("test");
  });

  it("throws on invalid YAML syntax", () => {
    expect(() => parseRule("{{not: valid")).toThrow(
      /Failed to parse rule YAML/
    );
  });

  it("throws on invalid rule structure", () => {
    expect(() => parseRule({ id: "test" })).toThrow(/Invalid rule structure/);
  });
});

// ---------------------------------------------------------------------------
// extractGatesConfig() tests
// ---------------------------------------------------------------------------

describe("extractGatesConfig", () => {
  it("extracts gates from full repo-spec", () => {
    const yaml = readFileSync(REPO_SPEC_PATH, "utf-8");
    const spec = parseRepoSpec(yaml);
    const config = extractGatesConfig(spec);

    expect(config.gates.length).toBeGreaterThanOrEqual(4);
    expect(config.gates[0]?.type).toBe("review-limits");
    expect(config.failOnError).toBe(true);
  });

  it("returns empty gates array when none configured", () => {
    const spec = parseRepoSpec({
      node_id: "00000000-0000-4000-8000-000000000001",
      cogni_dao: { chain_id: "8453" },
      payments_in: {
        credits_topup: {
          provider: "test",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    const config = extractGatesConfig(spec);
    expect(config.gates).toEqual([]);
    expect(config.failOnError).toBe(false);
  });
});
