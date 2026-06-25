// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/testing`
 * Purpose: Reusable fixtures for tests that need a parsed RepoSpec or Rule. Stable UUIDs,
 *   builder functions, and ready-made registry entries — replaces ad-hoc inline
 *   `parseRepoSpec({...})` calls duplicated across the workspace.
 * Scope: Test code only. Lives on a separate `@cogni/repo-spec/testing` subpath and does not
 *   ship in the production import surface. Import from this module in any test that needs to
 *   construct a RepoSpec / Rule fixture; do not replicate the inline parseRepoSpec pattern.
 * Invariants: Pure builders — no I/O, no global state. UUIDs are deterministic and disjoint
 *   from any production node_id (no collision with real `.cogni/repo-spec.yaml`).
 * Side-effects: none
 * Links: docs/spec/node-operator-contract.md, packages/repo-spec/src/schema.ts
 * @public
 */

import { parseRepoSpec } from "./parse.js";
import { parseRule } from "./rules.js";
import type { RepoSpec, Rule } from "./schema.js";

// ---------------------------------------------------------------------------
// Stable test identities (disjoint from production UUIDs)
// ---------------------------------------------------------------------------

/**
 * Deterministic UUIDs for tests. The `00000000-0000-4000-8000-…` prefix is reserved
 * for fixtures and is guaranteed not to collide with any real node_id in production
 * `.cogni/repo-spec.yaml` files.
 */
export const TEST_NODE_IDS = {
  /** Default node_id used by `buildTestRepoSpec` when no override is supplied. */
  default: "00000000-0000-4000-8000-000000000001",
  operator: "00000000-0000-4000-8000-000000000010",
  poly: "00000000-0000-4000-8000-000000000011",
  resy: "00000000-0000-4000-8000-000000000012",
  /** Use to assert miss-paths: this UUID is intentionally absent from any registry. */
  unregistered: "00000000-0000-4000-8000-0000000000ff",
} as const;

export const TEST_SCOPE_ID = "00000000-0000-4000-8000-000000000002";
export const TEST_CHAIN_ID = 8453;
export const TEST_RECEIVING_ADDRESS =
  "0x1111111111111111111111111111111111111111";
export const TEST_APPROVER_ADDRESS =
  "0x070075F1389Ae1182aBac722B36CA12285d0c949";

/**
 * Ready-made `nodes[]` entries for the operator/poly/resy triple.
 * Mirrors the shape of production root `.cogni/repo-spec.yaml`'s `nodes[]` array
 * but uses test UUIDs. Use these as-is, or spread + override.
 */
export const TEST_NODE_ENTRIES = {
  operator: {
    node_id: TEST_NODE_IDS.operator,
    node_name: "Cogni Operator",
    path: "nodes/operator",
  },
  poly: {
    node_id: TEST_NODE_IDS.poly,
    node_name: "Poly Prediction",
    path: "nodes/poly",
  },
  resy: {
    node_id: TEST_NODE_IDS.resy,
    node_name: "Resy Helper",
    path: "nodes/resy",
  },
} as const;

// ---------------------------------------------------------------------------
// RepoSpec builders (object input — preferred for accessor tests)
// ---------------------------------------------------------------------------

/**
 * Build a parsed `RepoSpec` from minimal-valid inputs plus arbitrary overrides.
 * Replaces the ad-hoc `parseRepoSpec({ node_id: ..., governance: { ... }, ... })`
 * pattern duplicated across `tests/unit/packages/repo-spec/*.test.ts` and any
 * test that needs a `RepoSpec` fixture.
 *
 * The default fixture has `node_id`, `governance.chain_id`, and `payments_in.credits_topup`
 * set — enough to satisfy `parseRepoSpec` for the largest set of accessor tests.
 * Override any field to introduce variant shapes (gates, nodes, ledger, etc.).
 */
export function buildTestRepoSpec(
  overrides: Record<string, unknown> = {}
): RepoSpec {
  return parseRepoSpec({
    node_id: TEST_NODE_IDS.default,
    governance: { chain_id: String(TEST_CHAIN_ID) },
    payments_in: {
      credits_topup: {
        provider: "cogni-usdc-backend-v1",
        receiving_address: TEST_RECEIVING_ADDRESS,
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// RepoSpec builders (yaml-string output — for tests that round-trip YAML)
// ---------------------------------------------------------------------------

interface RepoSpecYamlOptions {
  /**
   * Trailing yaml block appended after the minimal header. Pass a multi-line
   * string for `gates:`, `nodes:`, etc. Lines must be indented to match yaml syntax.
   */
  readonly extra?: string;
  /** Override the node_id field (default: `TEST_NODE_IDS.operator`). */
  readonly nodeId?: string;
}

/**
 * Build a YAML string of a minimal-valid RepoSpec. For tests where the production
 * code reads YAML from disk (e.g., `readRepoSpec()` returning a string) and the test
 * must inject a fixture string — round-trips through real `parseRepoSpec` in the
 * code under test.
 */
export function buildTestRepoSpecYaml(opts: RepoSpecYamlOptions = {}): string {
  const nodeId = opts.nodeId ?? TEST_NODE_IDS.operator;
  return `node_id: "${nodeId}"
governance:
  chain_id: "${TEST_CHAIN_ID}"
${opts.extra ?? ""}`;
}

// ---------------------------------------------------------------------------
// Rule builders
// ---------------------------------------------------------------------------

/**
 * Build a parsed `Rule` from minimal-valid inputs plus overrides. Default fixture
 * has one evaluation `foo` with a `gte: 0.8` requirement — enough for most
 * gate-orchestrator and review-handler tests to exercise pass/fail branches by
 * varying the LLM score.
 */
export function buildTestRule(overrides: Record<string, unknown> = {}): Rule {
  return parseRule({
    id: "test-rule",
    schema_version: "0.3",
    blocking: true,
    evaluations: [{ foo: "Evaluate metric foo on a 0-1 scale." }],
    success_criteria: {
      neutral_on_missing_metrics: false,
      require: [{ metric: "foo", gte: 0.8 }],
    },
    ...overrides,
  });
}

/** YAML-string variant of `buildTestRule` for tests that round-trip YAML through `parseRule`. */
export function buildTestRuleYaml(): string {
  return `id: test-rule
schema_version: "0.3"
blocking: true
evaluations:
  - foo: Evaluate metric foo on a 0-1 scale.
success_criteria:
  neutral_on_missing_metrics: false
  require:
    - metric: foo
      gte: 0.8
`;
}
