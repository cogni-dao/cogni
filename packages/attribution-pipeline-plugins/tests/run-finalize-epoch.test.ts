// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/tests/run-finalize-epoch`
 * Purpose: Unit tests for runFinalizeEpoch — the runtime-agnostic epoch finalize + R3 cumulative fold (story.5007).
 * Scope: Drives runFinalizeEpoch with a mocked AttributionStore + resolver. Covers the happy path, the bug.5020 per-node distribution-config seam (active/inactive/transient), the execute-guard, and the bug.5022 FREEZE. Lives here (not scheduler-worker) so `vi.mock("viem")` intercepts the SAME viem module runFinalizeEpoch imports.
 * Invariants: EPOCH_FINALIZE_IDEMPOTENT, FINALIZE_BUILDS_CUMULATIVE_ROOT, FREEZE (bug.5022), bug.5020 execute-guard.
 * Side-effects: none
 * Links: packages/attribution-pipeline-plugins/src/finalize/run-finalize-epoch.ts
 * @internal
 */

import type {
  AttributionEpoch,
  AttributionEvaluation,
  AttributionStore,
} from "@cogni/attribution-ledger";
import { computeApproverSetHash } from "@cogni/attribution-ledger";
import { verifyTypedData } from "viem";
import { describe, expect, it, vi } from "vitest";

// Partial mock: stub ONLY verifyTypedData (fake sigs verify), keep every other viem
// export real — the R3 merkle fold uses viem's `isAddress`/keccak, which must not vanish.
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  verifyTypedData: vi.fn(),
}));

import {
  type FinalizeDistributionConfigResolver,
  runFinalizeEpoch,
} from "../src/finalize/run-finalize-epoch";
import { createDefaultRegistries } from "../src/registry";

const NODE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SCOPE_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const registries = createDefaultRegistries();

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof runFinalizeEpoch>[0]["logger"];

function makeMockStore(
  overrides: Partial<AttributionStore> = {}
): AttributionStore {
  return {
    createEpoch: vi.fn(),
    getOpenEpoch: vi.fn().mockResolvedValue(null),
    getEpochByWindow: vi.fn().mockResolvedValue(null),
    getEpoch: vi.fn(),
    listEpochs: vi.fn(),
    closeIngestion: vi.fn(),
    closeIngestionWithEvaluations: vi.fn(),
    transitionEpochForWindow: vi.fn(),
    finalizeEpoch: vi.fn(),
    upsertDraftEvaluation: vi.fn(),
    getEvaluationsForEpoch: vi.fn().mockResolvedValue([]),
    getEvaluation: vi.fn().mockResolvedValue(null),
    getSelectedReceiptsForAttribution: vi.fn().mockResolvedValue([]),
    getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue([]),
    insertIngestionReceipts: vi.fn(),
    getReceiptsForWindow: vi.fn(),
    getAllReceipts: vi.fn().mockResolvedValue([]),
    upsertSelection: vi.fn(),
    getSelectionForEpoch: vi.fn(),
    getUnresolvedSelection: vi.fn(),
    upsertDraftClaimants: vi.fn(),
    lockClaimantsForEpoch: vi.fn(),
    loadLockedClaimants: vi.fn().mockResolvedValue([]),
    insertUserProjections: vi.fn(),
    upsertUserProjections: vi.fn(),
    deleteStaleUserProjections: vi.fn(),
    getUserProjectionsForEpoch: vi.fn(),
    replaceFinalClaimantAllocations: vi.fn(),
    getFinalClaimantAllocationsForEpoch: vi.fn(),
    getUserDisplayNames: vi.fn().mockResolvedValue(new Map()),
    upsertCursor: vi.fn(),
    getCursor: vi.fn().mockResolvedValue(null),
    insertPoolComponent: vi
      .fn()
      .mockResolvedValue({ component: {}, created: true }),
    getPoolComponentsForEpoch: vi.fn(),
    insertEpochStatement: vi.fn(),
    getStatementForEpoch: vi.fn(),
    insertStatementSignature: vi.fn(),
    getSignaturesForStatement: vi.fn(),
    insertSelectionDoNothing: vi.fn(),
    resolveIdentities: vi.fn().mockResolvedValue(new Map()),
    getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([]),
    finalizeEpochAtomic: vi.fn(),
    getSelectionCandidates: vi.fn().mockResolvedValue([]),
    updateSelectionUserId: vi.fn(),
    updateSelectionIncluded: vi.fn(),
    upsertReviewSubjectOverride: vi.fn(),
    batchUpsertReviewSubjectOverrides: vi.fn().mockResolvedValue([]),
    deleteReviewSubjectOverride: vi.fn(),
    getReviewSubjectOverridesForEpoch: vi.fn().mockResolvedValue([]),
    listActorContributionAllocationsForEpoch: vi.fn().mockResolvedValue([]),
    listUnfoldedActorContributionAllocationsForEpoch: vi
      .fn()
      .mockResolvedValue([]),
    listPendingActorDistributionLiabilities: vi.fn().mockResolvedValue([]),
    insertActorDistributionLiabilities: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as AttributionStore;
}

function makeEpoch(
  overrides: Partial<AttributionEpoch> = {}
): AttributionEpoch {
  return {
    id: 1n,
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    status: "open",
    periodStart: new Date("2026-02-16T00:00:00Z"),
    periodEnd: new Date("2026-02-23T00:00:00Z"),
    weightConfig: { "github:pr_merged": 1000 },
    poolTotalCredits: null,
    approverSetHash: null,
    approvers: null,
    allocationAlgoRef: null,
    weightConfigHash: null,
    artifactsHash: null,
    openedAt: new Date(),
    closedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEvaluation(
  overrides: Partial<AttributionEvaluation> = {}
): AttributionEvaluation {
  return {
    id: "eval-1",
    nodeId: NODE_ID,
    epochId: 1n,
    evaluationRef: "cogni.echo.v0",
    status: "draft",
    algoRef: "echo-v0",
    inputsHash: "inputs-hash",
    payloadHash: "payload-hash",
    payloadJson: {
      totalEvents: 1,
      byEventType: { pr_merged: 1 },
      byUserId: { "user-1": 1 },
    },
    payloadRef: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("finalizeEpoch", () => {
  it("finalizes using claimant allocations and preserves unresolved identities", async () => {
    vi.mocked(verifyTypedData).mockResolvedValue(true);

    const signer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reviewEpoch = makeEpoch({
      status: "review",
      allocationAlgoRef: "weight-sum-v0",
      weightConfigHash: "weight-hash",
      approvers: [signer],
      approverSetHash: await computeApproverSetHash([signer]),
    });

    const finalizeEpochAtomic = vi.fn().mockImplementation(async (params) => ({
      epoch: {
        ...reviewEpoch,
        status: "finalized",
        poolTotalCredits: params.poolTotal,
        closedAt: new Date(),
      },
      statement: {
        id: "stmt-1",
        nodeId: NODE_ID,
        epochId: reviewEpoch.id,
        finalAllocationSetHash: params.statement.finalAllocationSetHash,
        poolTotalCredits: params.statement.poolTotalCredits,
        statementLines: params.statement.statementLines,
        supersedesStatementId: null,
        createdAt: new Date(),
      },
    }));

    const store = makeMockStore({
      getEpoch: vi.fn().mockResolvedValue(reviewEpoch),
      loadLockedClaimants: vi.fn().mockResolvedValue([
        {
          id: "claimant-1",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          receiptId: "receipt-1",
          status: "locked" as const,
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: "inputs-hash-1",
          claimantKeys: ["user:user-1"],
          createdAt: new Date(),
          createdBy: "system",
        },
        {
          id: "claimant-2",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          receiptId: "receipt-2",
          status: "locked" as const,
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: "inputs-hash-2",
          claimantKeys: ["identity:github:42"],
          createdAt: new Date(),
          createdBy: "system",
        },
      ]),
      getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([
        {
          receiptId: "receipt-1",
          userId: "user-1",
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
        {
          receiptId: "receipt-2",
          userId: "user-1",
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
      ]),
      getEvaluationsForEpoch: vi.fn().mockResolvedValue([
        makeEvaluation({
          status: "locked",
          epochId: reviewEpoch.id,
          payloadJson: {
            totalEvents: 2,
            byEventType: { pr_merged: 2 },
            byUserId: { "user-1": 2 },
          },
        }),
      ]),
      getPoolComponentsForEpoch: vi.fn().mockResolvedValue([
        {
          id: "pool-1",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          componentId: "base_issuance",
          algorithmVersion: "v1",
          inputsJson: { base_amount: 10000 },
          amountCredits: 10000n,
          evidenceRef: null,
          computedAt: new Date(),
        },
      ]),
      finalizeEpochAtomic,
    });

    const result = await runFinalizeEpoch(
      {
        attributionStore: store,
        registries,
        nodeId: NODE_ID,
        scopeId: SCOPE_ID,
        chainId: 8453,
        tokenAddress: null,
        distributorAddress: null,
        walletResolver: null,
        deploymentEnvironment: "test",
        logger: mockLogger,
      },
      {
        epochId: reviewEpoch.id.toString(),
        signature: "0xdeadbeef",
        signerAddress: signer,
      }
    );

    expect(result.statementLineCount).toBe(2);
    expect(finalizeEpochAtomic).toHaveBeenCalledTimes(1);
    expect(verifyTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ deploymentEnvironment: "test" }),
      })
    );

    const finalizeParams = finalizeEpochAtomic.mock.calls[0]?.[0];
    // Both receipts have equal weight (same eventType, no override), each claimant owns one receipt
    expect(finalizeParams.statement.statementLines).toEqual([
      expect.objectContaining({
        claimant_key: "identity:github:42",
        final_units: expect.any(String),
      }),
      expect.objectContaining({
        claimant_key: "user:user-1",
        final_units: expect.any(String),
      }),
    ]);
  });
});

// ── R3 fold: per-node distribution-config seam + execute-guard (bug.5020) ─────
describe("finalizeEpoch — per-node distribution config (bug.5020)", () => {
  const SIGNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const WALLET = "0x1111111111111111111111111111111111111111";
  const THROWAWAY_TOKEN = "0x2a6d69fc00000000000000000000000000000001";
  const THROWAWAY_DAO = "0x7ded1c9600000000000000000000000000000002";
  const THROWAWAY_DIST = "0x3333333333333333333333333333333333333333";
  const BAKED_TOKEN = "0x4444444444444444444444444444444444444444";
  const BAKED_DIST = "0x5555555555555555555555555555555555555555";
  const BAKED_DAO = "0x6666666666666666666666666666666666666666"; // non-prod baked holder
  const PROD_COGNI_DAO = "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6";

  /** Wallet resolver that maps every claimant key to one contributor wallet. */
  const walletResolver = {
    resolveWallets: vi.fn(async (keys: readonly string[]) =>
      keys.map((claimantKey) => ({
        claimantKey,
        userId: "user-1",
        wallet: WALLET as `0x${string}`,
      }))
    ),
  };

  /** Full happy-path finalize store + R3 manifest methods. */
  async function makeFinalizeStore(
    overrides: Partial<AttributionStore> = {}
  ): Promise<{ store: AttributionStore; reviewEpoch: AttributionEpoch }> {
    const reviewEpoch = makeEpoch({
      id: 7n,
      status: "review",
      allocationAlgoRef: "weight-sum-v0",
      weightConfigHash: "weight-hash",
      approvers: [SIGNER],
      approverSetHash: await computeApproverSetHash([SIGNER]),
    });
    const store = makeMockStore({
      getEpoch: vi.fn().mockResolvedValue(reviewEpoch),
      loadLockedClaimants: vi.fn().mockResolvedValue([
        {
          id: "claimant-1",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          receiptId: "receipt-1",
          status: "locked" as const,
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: "inputs-hash-1",
          claimantKeys: ["user:user-1"],
          createdAt: new Date(),
          createdBy: "system",
        },
      ]),
      getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([
        {
          receiptId: "receipt-1",
          userId: "user-1",
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
      ]),
      getEvaluationsForEpoch: vi.fn().mockResolvedValue([
        makeEvaluation({
          status: "locked",
          epochId: reviewEpoch.id,
          payloadJson: {
            totalEvents: 1,
            byEventType: { pr_merged: 1 },
            byUserId: { "user-1": 1 },
          },
        }),
      ]),
      getPoolComponentsForEpoch: vi.fn().mockResolvedValue([
        {
          id: "pool-1",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          componentId: "base_issuance",
          algorithmVersion: "v1",
          inputsJson: { base_amount: 10000 },
          amountCredits: 10000n,
          evidenceRef: null,
          computedAt: new Date(),
        },
      ]),
      finalizeEpochAtomic: vi.fn().mockImplementation(async (params) => ({
        epoch: { ...reviewEpoch, status: "finalized", closedAt: new Date() },
        statement: {
          id: "stmt-1",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          finalAllocationSetHash: params.statement.finalAllocationSetHash,
          poolTotalCredits: params.statement.poolTotalCredits,
          statementLines: params.statement.statementLines,
          supersedesStatementId: null,
          createdAt: new Date(),
        },
      })),
      // R3 manifest methods (first epoch: no prior manifest)
      listEpochs: vi.fn().mockResolvedValue([reviewEpoch]),
      getDistributionManifestForEpoch: vi.fn().mockResolvedValue(null),
      getDistributionLeavesForEpoch: vi.fn().mockResolvedValue([]),
      upsertDistributionManifest: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });
    return { store, reviewEpoch };
  }

  function makeConfigClient(
    impl: FinalizeDistributionConfigResolver["resolveForNode"]
  ): FinalizeDistributionConfigResolver {
    return { resolveForNode: vi.fn(impl) };
  }

  // Build the finalize deps the way the app route/container does, then exercise the
  // extracted `runFinalizeEpoch` directly (story.5007 — finalize left the worker).
  function finalizeDepsWith(
    store: AttributionStore,
    opts: {
      distributionConfigClient?: FinalizeDistributionConfigResolver | null;
      deploymentEnvironment?: string;
      tokenAddress?: string | null;
      distributorAddress?: string | null;
      emissionsHolderAddress?: string | null;
      withWalletResolver?: boolean;
    }
  ) {
    vi.mocked(verifyTypedData).mockResolvedValue(true);
    return {
      attributionStore: store,
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      tokenAddress: opts.tokenAddress ?? null,
      distributorAddress: opts.distributorAddress ?? null,
      emissionsHolderAddress: opts.emissionsHolderAddress ?? null,
      walletResolver: (opts.withWalletResolver === false
        ? null
        : walletResolver) as Parameters<
        typeof runFinalizeEpoch
      >[0]["walletResolver"],
      distributionConfigClient: opts.distributionConfigClient ?? null,
      deploymentEnvironment: opts.deploymentEnvironment ?? "test",
      logger: mockLogger,
    };
  }

  async function runFinalize(deps: ReturnType<typeof finalizeDepsWith>) {
    return runFinalizeEpoch(deps, {
      epochId: "7",
      signature: "0xdeadbeef",
      signerAddress: SIGNER,
    });
  }

  it("fails closed before reading the epoch when deployment config is absent", async () => {
    const { store } = await makeFinalizeStore();
    const deps = finalizeDepsWith(store, {});

    await expect(
      runFinalize({ ...deps, deploymentEnvironment: undefined })
    ).rejects.toThrow(/DEPLOY_ENVIRONMENT/);
    expect(store.getEpoch).not.toHaveBeenCalled();
  });

  it("ACTIVE: folds against the per-node config from the gateway (not baked)", async () => {
    const { store } = await makeFinalizeStore();
    const client = makeConfigClient(async () => ({
      distribution: {
        chainId: 8453,
        tokenAddress: THROWAWAY_TOKEN,
        emissionsHolderAddress: THROWAWAY_DAO,
        distributorAddress: THROWAWAY_DIST,
      },
    }));
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "candidate-a",
      // baked = prod token to prove the gateway wins, not the baked value
      tokenAddress: BAKED_TOKEN,
      distributorAddress: BAKED_DIST,
    });

    const result = await runFinalize(deps);

    expect(client.resolveForNode).toHaveBeenCalledWith(NODE_ID);
    expect(store.upsertDistributionManifest).toHaveBeenCalledTimes(1);
    const manifest = vi.mocked(store.upsertDistributionManifest).mock
      .calls[0]?.[0];
    expect(manifest.tokenAddress.toLowerCase()).toBe(
      THROWAWAY_TOKEN.toLowerCase()
    );
    expect(manifest.distributorAddress?.toLowerCase()).toBe(
      THROWAWAY_DIST.toLowerCase()
    );
    expect(result.cumulativeDistribution?.tokenAddress.toLowerCase()).toBe(
      THROWAWAY_TOKEN.toLowerCase()
    );
  });

  it("INACTIVE: gateway reports not-activated → fold no-ops, off-chain finalize stands", async () => {
    const { store } = await makeFinalizeStore();
    const client = makeConfigClient(async () => ({
      distribution: null,
      reason: "distributions_inactive",
    }));
    // baked token present — proves the authoritative "inactive" is NOT overridden by baked
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "candidate-a",
      tokenAddress: BAKED_TOKEN,
      distributorAddress: BAKED_DIST,
    });

    const result = await runFinalize(deps);

    expect(store.upsertDistributionManifest).not.toHaveBeenCalled();
    expect(result.cumulativeDistribution).toBeNull();
    expect(result.statementId).toBe("stmt-1"); // finalize still succeeded
  });

  it("TRANSIENT: gateway throws → falls back to baked config; finalize is never undone", async () => {
    const { store } = await makeFinalizeStore();
    const client = makeConfigClient(async () => {
      throw new Error("gateway 503");
    });
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "candidate-a",
      tokenAddress: BAKED_TOKEN,
      distributorAddress: BAKED_DIST,
      // The real container bakes the emissions holder from the worker's OWN repo-spec, so the
      // baked-fallback path carries a checkable (non-prod) governance target.
      emissionsHolderAddress: BAKED_DAO,
    });

    const result = await runFinalize(deps);

    expect(store.upsertDistributionManifest).toHaveBeenCalledTimes(1);
    const manifest = vi.mocked(store.upsertDistributionManifest).mock
      .calls[0]?.[0];
    expect(manifest.tokenAddress.toLowerCase()).toBe(BAKED_TOKEN.toLowerCase());
    expect(result.statementId).toBe("stmt-1");
  });

  it("GUARD (baked): transient fallback to a baked PROD DAO holder → refused, finalize stands", async () => {
    const { store } = await makeFinalizeStore();
    const client = makeConfigClient(async () => {
      throw new Error("gateway 503");
    });
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "candidate-a", // non-production
      tokenAddress: BAKED_TOKEN,
      distributorAddress: BAKED_DIST,
      emissionsHolderAddress: PROD_COGNI_DAO, // baked spec somehow carries prod governance
    });

    const result = await runFinalize(deps);

    expect(store.upsertDistributionManifest).not.toHaveBeenCalled();
    expect(result.cumulativeDistribution).toBeNull();
    expect(result.statementId).toBe("stmt-1");
  });

  it("GUARD (unknown): non-prod baked fallback with NO known holder → fail-closed, finalize stands", async () => {
    const { store } = await makeFinalizeStore();
    const client = makeConfigClient(async () => {
      throw new Error("gateway 503");
    });
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "candidate-a",
      tokenAddress: BAKED_TOKEN,
      distributorAddress: BAKED_DIST,
      // emissionsHolderAddress omitted → null: cannot prove the target is not prod.
    });

    const result = await runFinalize(deps);

    expect(store.upsertDistributionManifest).not.toHaveBeenCalled();
    expect(result.cumulativeDistribution).toBeNull();
    expect(result.statementId).toBe("stmt-1");
  });

  it("FREEZE (bug.5022): an epoch that already has a manifest is preserved — never re-folded/overwritten", async () => {
    const FROZEN_ROOT =
      "0xaaaa000000000000000000000000000000000000000000000000000000000000";
    const { store } = await makeFinalizeStore({
      // A manifest ALREADY exists for epoch 7n (it was built + possibly published on a
      // prior finalize). A re-finalize must NOT re-fold and overwrite it.
      getDistributionManifestForEpoch: vi.fn().mockResolvedValue({
        id: "manifest-7",
        nodeId: NODE_ID,
        scopeId: SCOPE_ID,
        epochId: 7n,
        distributionId: "epoch-7",
        statementHash: "0xstatement",
        merkleRoot: FROZEN_ROOT,
        chainId: 8453,
        tokenAddress: THROWAWAY_TOKEN,
        distributionAmount: 12000000000000000000000n,
        totalAllocated: 12000000000000000000000n,
        distributorAddress: THROWAWAY_DIST,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getDistributionLeavesForEpoch: vi.fn().mockResolvedValue([
        {
          index: 0,
          claimantKey: "user:user-1",
          account: "0x1111111111111111111111111111111111111111",
          amount: 12000000000000000000000n,
          leafHash: "0xleaf",
          proof: [],
        },
      ]),
    });
    // Config resolves to a valid throwaway target — proving the freeze short-circuits
    // BEFORE any (re)build, not merely because the fold was inactive.
    const client = makeConfigClient(async () => ({
      distribution: {
        chainId: 8453,
        tokenAddress: THROWAWAY_TOKEN,
        emissionsHolderAddress: THROWAWAY_DAO,
        distributorAddress: THROWAWAY_DIST,
      },
    }));
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "candidate-a",
    });

    const result = await runFinalize(deps);

    // The manifest is preserved: no overwrite, no new mint.
    expect(store.upsertDistributionManifest).not.toHaveBeenCalled();
    expect(result.statementId).toBe("stmt-1"); // off-chain finalize untouched
    expect(result.cumulativeDistribution).not.toBeNull();
    const dist = result.cumulativeDistribution as NonNullable<
      typeof result.cumulativeDistribution
    >;
    expect(dist.merkleRoot).toBe(FROZEN_ROOT); // root unchanged
    expect(dist.mintDelta).toBe("0"); // nothing new to publish
  });

  it("GUARD: non-production worker refuses the PRODUCTION DAO → no manifest, finalize stands", async () => {
    const { store } = await makeFinalizeStore();
    const client = makeConfigClient(async () => ({
      distribution: {
        chainId: 8453,
        tokenAddress: THROWAWAY_TOKEN,
        emissionsHolderAddress: PROD_COGNI_DAO, // the prod DAO
        distributorAddress: THROWAWAY_DIST,
      },
    }));
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "candidate-a", // non-production
    });

    const result = await runFinalize(deps);

    expect(store.upsertDistributionManifest).not.toHaveBeenCalled();
    expect(result.cumulativeDistribution).toBeNull();
    expect(result.statementId).toBe("stmt-1"); // off-chain finalize untouched
  });

  it("GUARD: production worker is allowed to build against the production DAO", async () => {
    const { store } = await makeFinalizeStore();
    const client = makeConfigClient(async () => ({
      distribution: {
        chainId: 8453,
        tokenAddress: THROWAWAY_TOKEN,
        emissionsHolderAddress: PROD_COGNI_DAO,
        distributorAddress: THROWAWAY_DIST,
      },
    }));
    const deps = finalizeDepsWith(store, {
      distributionConfigClient: client,
      deploymentEnvironment: "production",
    });

    const result = await runFinalize(deps);

    expect(store.upsertDistributionManifest).toHaveBeenCalledTimes(1);
    expect(result.cumulativeDistribution).not.toBeNull();
  });
});
