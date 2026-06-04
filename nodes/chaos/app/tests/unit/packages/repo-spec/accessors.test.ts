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
  extractOperatorWalletConfig,
  extractPaymentConfig,
  extractScopeId,
  parseRepoSpec,
  type RepoSpec,
} from "@cogni/repo-spec";
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
  it("returns schedules and ledger config when fully specified", () => {
    const config = extractGovernanceConfig(buildFullSpec());
    expect(config.schedules).toHaveLength(1);
    expect(config.schedules[0]?.charter).toBe("HEARTBEAT");
    expect(config.ledger).toBeDefined();
    expect(config.ledger?.scopeId).toBe(TEST_SCOPE_ID);
  });

  it("returns empty schedules when governance omitted", () => {
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

describe("extractOperatorWalletConfig", () => {
  it("returns undefined when operator_wallet is not set", () => {
    const spec = buildSpec();
    expect(extractOperatorWalletConfig(spec)).toBeUndefined();
  });

  it("returns operator wallet config when set", () => {
    const spec = buildSpec({
      operator_wallet: {
        address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const config = extractOperatorWalletConfig(spec);
    expect(config).toEqual({
      address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("rejects invalid EVM address", () => {
    expect(() =>
      buildSpec({
        operator_wallet: {
          address: "not-an-address",
        },
      })
    ).toThrow(/valid EVM address/);
  });
});
