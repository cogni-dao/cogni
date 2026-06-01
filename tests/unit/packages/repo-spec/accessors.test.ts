// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/accessors`
 * Purpose: Unit tests for typed accessor functions — happy path + edge cases.
 * Scope: Pure function tests against parsed RepoSpec objects. Does not perform disk I/O.
 * Invariants: Accessors are pure functions that extract config from a validated RepoSpec.
 * Side-effects: none
 * Links: packages/repo-spec/src/accessors.ts
 * @public
 */

import {
  extractChainId,
  extractGovernanceConfig,
  extractLedgerApprovers,
  extractLedgerConfig,
  extractNodeId,
  extractNodePath,
  extractOwningNode,
  extractPaymentConfig,
  extractScopeId,
  parseRepoSpec,
  type RepoSpec,
  resolveRulePath,
} from "@cogni/repo-spec";
import {
  buildTestRepoSpec,
  TEST_NODE_ENTRIES,
  TEST_NODE_IDS,
} from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";

const TEST_NODE_ID = "00000000-0000-4000-8000-000000000001";
const TEST_SCOPE_ID = "00000000-0000-4000-8000-000000000002";
const TEST_CHAIN_ID = 8453;

/** Builds a minimal valid RepoSpec for testing */
function buildSpec(overrides: Partial<RepoSpec> = {}): RepoSpec {
  return parseRepoSpec({
    node_id: TEST_NODE_ID,
    cogni_dao: { chain_id: String(TEST_CHAIN_ID) },
    payments_in: {
      credits_topup: {
        provider: "cogni-usdc-backend-v1",
        receiving_address: "0x1111111111111111111111111111111111111111",
      },
    },
    ...overrides,
  });
}

/** Builds a full RepoSpec with ledger config */
function buildFullSpec(): RepoSpec {
  return parseRepoSpec({
    node_id: TEST_NODE_ID,
    scope_id: TEST_SCOPE_ID,
    scope_key: "default",
    cogni_dao: { chain_id: String(TEST_CHAIN_ID) },
    payments_in: {
      credits_topup: {
        provider: "cogni-usdc-backend-v1",
        receiving_address: "0x1111111111111111111111111111111111111111",
      },
    },
    activity_ledger: {
      epoch_length_days: 7,
      approvers: ["0x070075F1389Ae1182aBac722B36CA12285d0c949"],
      pool_config: { base_issuance_credits: "10000" },
      activity_sources: {
        github: {
          attribution_pipeline: "cogni-v0.0",
          source_refs: ["cogni-dao/cogni-template"],
        },
      },
    },
    governance: {
      schedules: [
        {
          charter: "HEARTBEAT",
          cron: "0 * * * *",
          timezone: "UTC",
          entrypoint: "HEARTBEAT",
        },
      ],
    },
  });
}

describe("extractNodeId", () => {
  it("returns node_id from spec", () => {
    expect(extractNodeId(buildSpec())).toBe(TEST_NODE_ID);
  });
});

describe("extractScopeId", () => {
  it("returns scope_id when present", () => {
    const spec = buildSpec({ scope_id: TEST_SCOPE_ID });
    expect(extractScopeId(spec)).toBe(TEST_SCOPE_ID);
  });

  it("throws when scope_id is missing", () => {
    const spec = buildSpec();
    expect(() => extractScopeId(spec)).toThrow(/Missing scope_id/);
  });
});

describe("extractChainId", () => {
  it("parses string chain_id to number", () => {
    const spec = buildSpec();
    expect(extractChainId(spec)).toBe(TEST_CHAIN_ID);
  });

  it("handles numeric chain_id", () => {
    const spec = parseRepoSpec({
      node_id: TEST_NODE_ID,
      cogni_dao: { chain_id: 8453 },
      payments_in: {
        credits_topup: {
          provider: "test",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    expect(extractChainId(spec)).toBe(8453);
  });

  it("throws on non-numeric string", () => {
    const spec = parseRepoSpec({
      node_id: TEST_NODE_ID,
      cogni_dao: { chain_id: "not-a-number" },
      payments_in: {
        credits_topup: {
          provider: "test",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    expect(() => extractChainId(spec)).toThrow(/Invalid cogni_dao\.chain_id/);
  });
});

describe("extractPaymentConfig", () => {
  it("returns mapped payment config when chain matches", () => {
    const config = extractPaymentConfig(buildSpec(), TEST_CHAIN_ID);
    expect(config).toEqual({
      chainId: TEST_CHAIN_ID,
      receivingAddress: "0x1111111111111111111111111111111111111111",
      provider: "cogni-usdc-backend-v1",
    });
  });

  it("throws on chain mismatch", () => {
    expect(() => extractPaymentConfig(buildSpec(), 999)).toThrow(
      /Chain mismatch/
    );
  });

  it("trims whitespace from address and provider", () => {
    const spec = parseRepoSpec({
      node_id: TEST_NODE_ID,
      cogni_dao: { chain_id: String(TEST_CHAIN_ID) },
      payments_in: {
        credits_topup: {
          provider: " cogni-usdc-backend-v1 ",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    const config = extractPaymentConfig(spec, TEST_CHAIN_ID);
    expect(config.provider).toBe("cogni-usdc-backend-v1");
  });
});

describe("extractGovernanceConfig", () => {
  it("returns declared schedules plus a synthesized LEDGER_INGEST when an activity ledger is configured", () => {
    const config = extractGovernanceConfig(buildFullSpec());
    const charters = config.schedules.map((s) => s.charter);
    expect(charters).toContain("HEARTBEAT");
    expect(charters).toContain("LEDGER_INGEST");
    expect(config.ledger).toBeDefined();
    expect(config.ledger?.scopeId).toBe(TEST_SCOPE_ID);
  });

  it("synthesizes a LEDGER_INGEST schedule (daily cron) from activity_ledger when none is declared", () => {
    const config = extractGovernanceConfig(buildFullSpec());
    const ledgerSchedule = config.schedules.find(
      (s) => s.charter === "LEDGER_INGEST"
    );
    expect(ledgerSchedule).toMatchObject({
      charter: "LEDGER_INGEST",
      cron: "0 0 * * *",
      timezone: "UTC",
      entrypoint: "LEDGER_INGEST",
    });
  });

  it("does not duplicate LEDGER_INGEST when it is already declared", () => {
    const spec = parseRepoSpec({
      node_id: TEST_NODE_ID,
      scope_id: TEST_SCOPE_ID,
      scope_key: "default",
      cogni_dao: { chain_id: String(TEST_CHAIN_ID) },
      payments_in: {
        credits_topup: {
          provider: "cogni-usdc-backend-v1",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
      activity_ledger: {
        epoch_length_days: 7,
        approvers: [],
        activity_sources: {
          github: {
            attribution_pipeline: "cogni-v0.0",
            source_refs: ["cogni-dao/cogni-template"],
          },
        },
      },
      governance: {
        schedules: [
          {
            charter: "LEDGER_INGEST",
            cron: "0 6 * * *",
            timezone: "UTC",
            entrypoint: "LEDGER_INGEST",
          },
        ],
      },
    });
    const config = extractGovernanceConfig(spec);
    const ledgerSchedules = config.schedules.filter(
      (s) => s.charter.toUpperCase() === "LEDGER_INGEST"
    );
    expect(ledgerSchedules).toHaveLength(1);
    // declared cron is preserved (not overwritten by synthesis)
    expect(ledgerSchedules[0]?.cron).toBe("0 6 * * *");
  });

  it("returns empty schedules and no ledger when neither governance nor activity_ledger is present", () => {
    const config = extractGovernanceConfig(buildSpec());
    expect(config.schedules).toEqual([]);
    expect(config.ledger).toBeUndefined();
  });
});

describe("extractLedgerConfig", () => {
  it("returns ledger config when all fields present", () => {
    const ledger = extractLedgerConfig(buildFullSpec());
    expect(ledger).not.toBeNull();
    expect(ledger?.epochLengthDays).toBe(7);
    expect(ledger?.scopeId).toBe(TEST_SCOPE_ID);
    expect(ledger?.scopeKey).toBe("default");
    expect(ledger?.poolConfig.baseIssuanceCredits).toBe(10000n);
    expect(ledger?.baseIssuanceCredits).toBe("10000");
    expect(ledger?.approvers).toEqual([
      "0x070075F1389Ae1182aBac722B36CA12285d0c949",
    ]);
    expect(ledger?.activitySources.github).toEqual({
      attributionPipeline: "cogni-v0.0",
      sourceRefs: ["cogni-dao/cogni-template"],
    });
  });

  it("returns null when activity_ledger is missing", () => {
    expect(extractLedgerConfig(buildSpec())).toBeNull();
  });

  it("returns null when scope_id is missing", () => {
    const spec = parseRepoSpec({
      node_id: TEST_NODE_ID,
      cogni_dao: { chain_id: String(TEST_CHAIN_ID) },
      payments_in: {
        credits_topup: {
          provider: "test",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
      activity_ledger: {
        epoch_length_days: 7,
        activity_sources: {
          github: {
            attribution_pipeline: "cogni-v0.0",
            source_refs: ["r"],
          },
        },
      },
    });
    expect(extractLedgerConfig(spec)).toBeNull();
  });

  it("defaults pool baseIssuanceCredits to 0n when pool_config missing", () => {
    const spec = parseRepoSpec({
      node_id: TEST_NODE_ID,
      scope_id: TEST_SCOPE_ID,
      scope_key: "default",
      cogni_dao: { chain_id: String(TEST_CHAIN_ID) },
      payments_in: {
        credits_topup: {
          provider: "test",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
      activity_ledger: {
        epoch_length_days: 7,
        activity_sources: {
          github: {
            attribution_pipeline: "cogni-v0.0",
            source_refs: ["r"],
          },
        },
      },
    });
    const ledger = extractLedgerConfig(spec);
    expect(ledger?.poolConfig.baseIssuanceCredits).toBe(0n);
  });
});

describe("extractLedgerApprovers", () => {
  it("returns lowercased approver addresses", () => {
    const approvers = extractLedgerApprovers(buildFullSpec());
    expect(approvers).toEqual(["0x070075f1389ae1182abac722b36ca12285d0c949"]);
  });

  it("returns empty array when activity_ledger is missing", () => {
    expect(extractLedgerApprovers(buildSpec())).toEqual([]);
  });

  it("returns empty array when approvers is empty", () => {
    const spec = parseRepoSpec({
      node_id: TEST_NODE_ID,
      scope_id: TEST_SCOPE_ID,
      scope_key: "default",
      cogni_dao: { chain_id: String(TEST_CHAIN_ID) },
      payments_in: {
        credits_topup: {
          provider: "test",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
      activity_ledger: {
        epoch_length_days: 7,
        activity_sources: {
          github: {
            attribution_pipeline: "cogni-v0.0",
            source_refs: ["r"],
          },
        },
      },
    });
    expect(extractLedgerApprovers(spec)).toEqual([]);
  });
});

describe("extractNodePath", () => {
  it("scenario 1: returns the registered path on match", () => {
    const spec = buildTestRepoSpec({
      nodes: [TEST_NODE_ENTRIES.poly, TEST_NODE_ENTRIES.resy],
    });
    expect(extractNodePath(spec, TEST_NODE_IDS.poly)).toBe("nodes/poly");
    expect(extractNodePath(spec, TEST_NODE_IDS.resy)).toBe("nodes/resy");
  });

  it("scenario 2: returns null when nodeId is not in the registry", () => {
    const spec = buildTestRepoSpec({ nodes: [TEST_NODE_ENTRIES.poly] });
    expect(extractNodePath(spec, TEST_NODE_IDS.unregistered)).toBeNull();
  });

  it("scenario 3: returns null when nodes[] is empty", () => {
    const spec = buildTestRepoSpec({ nodes: [] });
    expect(extractNodePath(spec, TEST_NODE_IDS.poly)).toBeNull();
  });

  it("scenario 4: returns null when nodes[] is missing entirely", () => {
    // No `nodes` override → builder omits the field, exercising the optional-registry path.
    const spec = buildTestRepoSpec();
    expect(extractNodePath(spec, TEST_NODE_IDS.poly)).toBeNull();
  });

  it("scenario 5: does NOT special-case the operator's own node_id", () => {
    const spec = buildTestRepoSpec({
      nodes: [TEST_NODE_ENTRIES.operator, TEST_NODE_ENTRIES.poly],
    });
    // Locks: registry path is returned verbatim even when nodeId is the operator's.
    // Caller decides whether to map "nodes/operator" to repoRoot/.cogni or nodes/operator/.cogni.
    expect(extractNodePath(spec, TEST_NODE_IDS.operator)).toBe(
      "nodes/operator"
    );
  });

  it("scenario 6: returns null for an empty-string nodeId (no spurious match)", () => {
    const spec = buildTestRepoSpec({ nodes: [TEST_NODE_ENTRIES.poly] });
    expect(extractNodePath(spec, "")).toBeNull();
  });

  it("scenario 7: returns the registered path verbatim — no normalization", () => {
    // Registry can declare any min(1) string. The function must not trim, normalize,
    // strip slashes, or modify the result. Path-safety is a caller responsibility.
    const cases = [
      "nodes/poly",
      "nodes/poly/",
      "./nodes/poly",
      "  spaced-path  ",
    ];
    for (const path of cases) {
      const spec = buildTestRepoSpec({
        nodes: [{ ...TEST_NODE_ENTRIES.poly, path }],
      });
      expect(extractNodePath(spec, TEST_NODE_IDS.poly)).toBe(path);
    }
  });

  it("scenario 8: on duplicate node_id, returns the first match (Array.find semantics)", () => {
    const spec = buildTestRepoSpec({
      nodes: [
        {
          ...TEST_NODE_ENTRIES.poly,
          node_name: "Poly A",
          path: "nodes/poly-a",
        },
        {
          ...TEST_NODE_ENTRIES.poly,
          node_name: "Poly B",
          path: "nodes/poly-b",
        },
      ],
    });
    expect(extractNodePath(spec, TEST_NODE_IDS.poly)).toBe("nodes/poly-a");
  });
});

describe("extractOwningNode", () => {
  /** Standard registry: operator + poly + resy. Mirrors production root .cogni/repo-spec.yaml shape. */
  const standardSpec = () =>
    buildTestRepoSpec({
      nodes: [
        TEST_NODE_ENTRIES.operator,
        TEST_NODE_ENTRIES.poly,
        TEST_NODE_ENTRIES.resy,
      ],
    });

  it("scenario 1: single sovereign node — all paths under nodes/poly/", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/foo.ts",
      "nodes/poly/graphs/bar.ts",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.poly,
      path: "nodes/poly",
    });
  });

  it("scenario 2: operator-only PR — non-`nodes/` paths classify as operator domain", () => {
    const result = extractOwningNode(standardSpec(), [
      "packages/repo-spec/src/x.ts",
      "infra/k8s/foo.yaml",
      "docs/spec/bar.md",
      ".github/workflows/ci.yaml",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.operator,
      path: "nodes/operator",
    });
  });

  it("scenario 3: operator-only PR — nodes/operator/** classifies as operator domain", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/operator/app/foo.ts",
      "nodes/operator/graphs/bar.ts",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.operator,
      path: "nodes/operator",
    });
  });

  it("scenario 4: mixed sovereign node + non-`nodes/` path → conflict (operator-infra is operator domain)", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/foo.ts",
      "packages/repo-spec/bar.ts",
    ]);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.nodes).toEqual([
      { nodeId: TEST_NODE_IDS.operator, path: "nodes/operator" },
      { nodeId: TEST_NODE_IDS.poly, path: "nodes/poly" },
    ]);
  });

  it("scenario 5: mixed sovereign node + nodes/operator/** → conflict (operator is a domain, not exemption)", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/foo.ts",
      "nodes/operator/app/bar.ts",
    ]);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.nodes).toEqual([
      { nodeId: TEST_NODE_IDS.operator, path: "nodes/operator" },
      { nodeId: TEST_NODE_IDS.poly, path: "nodes/poly" },
    ]);
    // Resolver labels operator territory + identity for the diagnostic formatter.
    expect(result.operatorPaths).toEqual(["nodes/operator/app/bar.ts"]);
    expect(result.operatorNodeId).toBe(TEST_NODE_IDS.operator);
  });

  it("scenario 5b: conflict between two sovereign nodes → operatorPaths empty, operatorNodeId undefined", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/foo.ts",
      "nodes/resy/bar.ts",
    ]);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.operatorPaths).toEqual([]);
    expect(result.operatorNodeId).toBeUndefined();
  });

  it("scenario 6: conflict — two sovereign nodes, sorted by nodeId", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/resy/foo.ts",
      "nodes/poly/bar.ts",
    ]);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.nodes).toEqual([
      { nodeId: TEST_NODE_IDS.poly, path: "nodes/poly" },
      { nodeId: TEST_NODE_IDS.resy, path: "nodes/resy" },
    ]);
  });

  it("scenario 7: conflict — three sovereign nodes, all named, sorted by nodeId", () => {
    const aiOnly = {
      node_id: "00000000-0000-4000-8000-000000000013",
      node_name: "AI Only",
      path: "nodes/ai-only",
    };
    const spec = buildTestRepoSpec({
      nodes: [
        TEST_NODE_ENTRIES.operator,
        TEST_NODE_ENTRIES.poly,
        TEST_NODE_ENTRIES.resy,
        aiOnly,
      ],
    });
    const result = extractOwningNode(spec, [
      "nodes/poly/foo.ts",
      "nodes/resy/bar.ts",
      "nodes/ai-only/baz.ts",
    ]);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.nodes).toEqual([
      { nodeId: TEST_NODE_IDS.poly, path: "nodes/poly" },
      { nodeId: TEST_NODE_IDS.resy, path: "nodes/resy" },
      { nodeId: aiOnly.node_id, path: "nodes/ai-only" },
    ]);
  });

  it("scenario 8: unregistered nodes/<x>/ falls through to operator domain", () => {
    // Per spec invariant: registry mirrors filesystem (meta-test enforces).
    // If a path under nodes/<unknown>/ leaks through, it classifies as operator —
    // matching the bash gate's filesystem-driven default. The meta-test catches the drift.
    const result = extractOwningNode(standardSpec(), [
      "nodes/unregistered-node/foo.ts",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.operator,
      path: "nodes/operator",
    });
  });

  it("scenario 9: empty input → miss (CI passes; reviewer surfaces no-op)", () => {
    expect(extractOwningNode(standardSpec(), [])).toEqual({ kind: "miss" });
  });

  it("scenario 10: node-template is sovereign when registered", () => {
    const nodeTemplate = {
      node_id: "00000000-0000-4000-8000-0000000000aa",
      node_name: "Node Template",
      path: "nodes/node-template",
    };
    const spec = buildTestRepoSpec({
      nodes: [TEST_NODE_ENTRIES.operator, nodeTemplate],
    });
    const result = extractOwningNode(spec, ["nodes/node-template/app/foo.ts"]);
    expect(result).toEqual({
      kind: "single",
      nodeId: nodeTemplate.node_id,
      path: "nodes/node-template",
    });
  });

  it("RIDE_ALONG: poly + pnpm-lock.yaml → single { poly, rideAlongApplied: true }", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/package.json",
      "pnpm-lock.yaml",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.poly,
      path: "nodes/poly",
      rideAlongApplied: true,
    });
  });

  it("RIDE_ALONG: poly + work/items/wi.foo.md → single { poly, rideAlongApplied: true }", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/src/foo.ts",
      "work/items/wi.poly-feature.md",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.poly,
      path: "nodes/poly",
      rideAlongApplied: true,
    });
  });

  it("RIDE_ALONG: poly + lockfile + work/items/_index → combined whitelist applies", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/package.json",
      "pnpm-lock.yaml",
      "work/items/_index.md",
      "work/items/wi.poly-feature.md",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.poly,
      path: "nodes/poly",
      rideAlongApplied: true,
    });
  });

  it("RIDE_ALONG: poly + poly manager skill status card → single { poly, rideAlongApplied: true }", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/src/foo.ts",
      ".claude/skills/poly-dev-manager/SKILL.md",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.poly,
      path: "nodes/poly",
      rideAlongApplied: true,
    });
  });

  it("RIDE_ALONG bounded: poly + lockfile + .github/foo defeats the exception → conflict", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/poly/app/package.json",
      "pnpm-lock.yaml",
      ".github/workflows/foo.yml",
    ]);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.nodes).toEqual([
      { nodeId: TEST_NODE_IDS.operator, path: "nodes/operator" },
      { nodeId: TEST_NODE_IDS.poly, path: "nodes/poly" },
    ]);
  });

  it("NODE_BIRTH ride-along: canary + its own catalog/overlay/AppSet → single { canary, rideAlongApplied: true }", () => {
    const canary = {
      node_id: "00000000-0000-4000-8000-0000000000ca",
      node_name: "Canary",
      path: "nodes/canary",
    };
    const spec = buildTestRepoSpec({
      nodes: [TEST_NODE_ENTRIES.operator, canary, TEST_NODE_ENTRIES.resy],
    });
    const result = extractOwningNode(spec, [
      "nodes/canary/app/src/app/(public)/page.tsx",
      "infra/catalog/canary.yaml",
      "infra/k8s/overlays/candidate-a/canary/kustomization.yaml",
      "infra/k8s/overlays/preview/canary/kustomization.yaml",
      "infra/k8s/argocd/candidate-a-applicationset.yaml",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: canary.node_id,
      path: "nodes/canary",
      rideAlongApplied: true,
    });
  });

  it("NODE_BIRTH bounded: canary cannot ride another node's catalog", () => {
    const canary = {
      node_id: "00000000-0000-4000-8000-0000000000ca",
      node_name: "Canary",
      path: "nodes/canary",
    };
    const spec = buildTestRepoSpec({
      nodes: [TEST_NODE_ENTRIES.operator, canary, TEST_NODE_ENTRIES.resy],
    });
    const result = extractOwningNode(spec, [
      "nodes/canary/app/src/foo.ts",
      "infra/catalog/resy.yaml",
    ]);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.nodes).toEqual([
      { nodeId: TEST_NODE_IDS.operator, path: "nodes/operator" },
      { nodeId: canary.node_id, path: "nodes/canary" },
    ]);
    expect(result.operatorPaths).toEqual(["infra/catalog/resy.yaml"]);
    expect(result.operatorNodeId).toBe(TEST_NODE_IDS.operator);
  });

  it("operator-only with mixed operator paths (nodes/operator/** + packages/ + docs/)", () => {
    const result = extractOwningNode(standardSpec(), [
      "nodes/operator/app/src/foo.ts",
      "packages/repo-spec/src/x.ts",
      ".github/workflows/ci.yaml",
      "docs/spec/architecture.md",
    ]);
    expect(result).toEqual({
      kind: "single",
      nodeId: TEST_NODE_IDS.operator,
      path: "nodes/operator",
    });
  });

  it("throws when operator entry is missing from registry on an operator-only PR (meta-test invariant)", () => {
    const spec = buildTestRepoSpec({ nodes: [TEST_NODE_ENTRIES.poly] });
    expect(() =>
      extractOwningNode(spec, ["packages/x.ts", "docs/y.md"])
    ).toThrow(/operator entry missing/);
  });
});

describe("resolveRulePath", () => {
  it("returns <path>/.cogni/rules for a sovereign single", () => {
    expect(
      resolveRulePath({
        kind: "single",
        nodeId: TEST_NODE_IDS.poly,
        path: "nodes/poly",
      })
    ).toBe("nodes/poly/.cogni/rules");
  });

  it("returns the same shape for operator — no special case", () => {
    expect(
      resolveRulePath({
        kind: "single",
        nodeId: TEST_NODE_IDS.operator,
        path: "nodes/operator",
      })
    ).toBe("nodes/operator/.cogni/rules");
  });

  it("throws on conflict and miss — caller must branch on kind", () => {
    expect(() => resolveRulePath({ kind: "miss" })).toThrow(
      /only valid for kind=single/
    );
    expect(() =>
      resolveRulePath({
        kind: "conflict",
        nodes: [],
        operatorPaths: [],
      })
    ).toThrow(/only valid for kind=single/);
  });
});
