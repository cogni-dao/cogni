// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/publish-epoch-build`
 * Purpose: Unit tests for the pure publish-epoch build mapping — finalized statement → FinalizedEpochStatement
 *   inputs + token budget. Asserts the V0 Walk credit→token mapping and that the frozen builder consumes
 *   the signed credit_amount weights, NOT finalUnits.
 * Scope: Pure-function tests only. The on-chain deploy/mint is a wallet step proven in the P4 spike — not asserted here.
 * Invariants:
 * - PUBLISH_BUDGET_FROM_POOL: budget = poolTotalCredits × 10^18.
 * - PUBLISH_CREDIT_WEIGHT: each line's credit_amount (string) → bigint weight.
 * Side-effects: none
 * Links: src/features/governance/publish-epoch/build-distribution.ts
 * @internal
 */

import type { ClaimantWalletResolver } from "@cogni/aragon-osx";
import { buildEpochDistribution } from "@cogni/aragon-osx";
import type {
  AttributionEpoch,
  AttributionStatement,
} from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";
import {
  epochTokenBudgetFromStatement,
  TOKEN_BASE_UNITS,
  toFinalizedEpochStatement,
} from "@/features/governance/publish-epoch/build-distribution";

const TOKEN = "0x0166Db3d42603E790Fb685059DcAa37087B032c8" as const;
const WALLET_A = "0x070075F1389ae1182AbAC722B36ca12285d0C949" as const;
const WALLET_B = "0xC0FFEe0000000000000000000000000000000001" as const;

function epoch(): AttributionEpoch {
  return {
    id: 42n,
    nodeId: "node-operator",
    scopeId: "scope-default",
    status: "finalized",
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-01-08T00:00:00Z"),
    weightConfig: {},
    poolTotalCredits: 100n,
    approverSetHash: "0xapprovers",
    approvers: ["0xadmin"],
    allocationAlgoRef: "algo@1",
    weightConfigHash: "0xcfg",
    artifactsHash: "0xart",
    openedAt: new Date("2026-01-01T00:00:00Z"),
    closedAt: new Date("2026-01-08T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function statement(
  lines: { claimant_key: string; credit_amount: string }[]
): AttributionStatement {
  return {
    id: "stmt-1",
    nodeId: "node-operator",
    epochId: 42n,
    finalAllocationSetHash: "0xstatementhash",
    poolTotalCredits: 100n,
    statementLines: lines.map((l) => ({
      claimant_key: l.claimant_key,
      claimant: { kind: "user", userId: l.claimant_key } as never,
      final_units: "0",
      pool_share: "0",
      credit_amount: l.credit_amount,
      receipt_ids: [],
    })),
    reviewOverrides: null,
    supersedesStatementId: null,
    createdAt: new Date("2026-01-08T00:00:00Z"),
  };
}

/** Resolver mapping claimant keys → wallets (null = unresolved). */
function resolverFor(
  map: Record<string, `0x${string}` | null>
): ClaimantWalletResolver {
  return {
    async resolveWallets(keys) {
      return keys.map((claimantKey) => ({
        claimantKey,
        userId: claimantKey,
        wallet: map[claimantKey] ?? null,
      }));
    },
  };
}

describe("epochTokenBudgetFromStatement", () => {
  it("maps poolTotalCredits 1:1 to whole tokens (× 10^18)", () => {
    expect(epochTokenBudgetFromStatement(statement([]))).toBe(
      100n * TOKEN_BASE_UNITS
    );
  });
});

describe("toFinalizedEpochStatement", () => {
  it("binds distributionId to the epoch and statementHash to the signed statement", () => {
    const finalized = toFinalizedEpochStatement(
      epoch(),
      statement([{ claimant_key: "a", credit_amount: "60" }]),
      { tokenAddress: TOKEN, chainId: 8453 }
    );
    expect(finalized.distributionId).toBe("epoch-42");
    expect(finalized.statementHash).toBe("0xstatementhash");
    expect(finalized.tokenAddress).toBe(TOKEN);
    expect(finalized.chainId).toBe(8453);
    expect(finalized.lines).toHaveLength(1);
    expect(finalized.lines[0]?.creditAmount).toBe(60n);
  });
});

describe("publish-epoch build → buildEpochDistribution (frozen root)", () => {
  it("splits the budget proportionally by signed credit_amount across resolved wallets", async () => {
    const stmt = statement([
      { claimant_key: "a", credit_amount: "60" },
      { claimant_key: "b", credit_amount: "40" },
    ]);
    const finalized = toFinalizedEpochStatement(epoch(), stmt, {
      tokenAddress: TOKEN,
      chainId: 8453,
    });
    const budget = epochTokenBudgetFromStatement(stmt);
    const { distribution, blockers } = await buildEpochDistribution(
      finalized,
      budget,
      resolverFor({ a: WALLET_A, b: WALLET_B })
    );

    expect(blockers).toHaveLength(0);
    expect(distribution).not.toBeNull();
    expect(distribution?.totalAllocated).toBe(budget);
    expect(distribution?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    // 60/40 split of the budget by credit weight.
    const amounts = distribution?.leaves.map((l) => l.amount) ?? [];
    expect(amounts).toContain((budget * 60n) / 100n);
    expect(amounts).toContain((budget * 40n) / 100n);
  });

  it("excludes an unresolved claimant and reports a claimants_unresolved blocker", async () => {
    const stmt = statement([
      { claimant_key: "a", credit_amount: "60" },
      { claimant_key: "b", credit_amount: "40" },
    ]);
    const finalized = toFinalizedEpochStatement(epoch(), stmt, {
      tokenAddress: TOKEN,
      chainId: 8453,
    });
    const { distribution, blockers, unresolvedClaimantKeys } =
      await buildEpochDistribution(
        finalized,
        epochTokenBudgetFromStatement(stmt),
        resolverFor({ a: WALLET_A, b: null })
      );

    expect(unresolvedClaimantKeys).toEqual(["b"]);
    expect(blockers.some((x) => x.code === "claimants_unresolved")).toBe(true);
    // The resolved claimant still gets a distribution.
    expect(distribution?.leaves).toHaveLength(1);
    expect(distribution?.leaves[0]?.account).toBe(WALLET_A);
  });
});
