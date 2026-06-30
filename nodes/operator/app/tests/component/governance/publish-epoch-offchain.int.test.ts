// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/governance/publish-epoch-offchain.int`
 * Purpose: Tier-1 component test for the Walk publish-epoch OFF-CHAIN path — proves the entire
 *   off-chain half end-to-end (NO anvil, NO real money): a FINALIZED, admin-signed epoch whose
 *   claimants have wallets produces a persisted, servable Merkle manifest.
 * Scope: Exercises the FROZEN buildEpochDistribution + DrizzleClaimantWalletResolver wallet
 *   resolution, the P3 manifest store round-trip, and the public distribution route — all against
 *   a real PostgreSQL via testcontainers. Does NOT deploy a distributor, mint, or move tokens.
 * Invariants:
 *   - WALLET_RESOLVED_GETS_LEAF: a claimant with a users.wallet_address resolves and gets a leaf.
 *   - UNLINKED_IS_UNRESOLVED: a claimant with no wallet is excluded as `claimants_unresolved`.
 *   - MANIFEST_ROUND_TRIPS: upsertDistributionManifest → getDistributionClaimForAccount returns
 *     the right {index, amount, proof, root} for the resolved account.
 *   - PUBLIC_READS_FINALIZED_ONLY: the public route serves the claim for a finalized epoch and
 *     404s for an unknown account / non-finalized epoch.
 * Side-effects: IO (database operations via testcontainers; in-process route handler invocation)
 * Links: nodes/operator/app/src/app/api/v1/nodes/[id]/publish-epoch/route.ts,
 *   packages/aragon-osx/src/epoch-distribution-service.ts,
 *   packages/db-client/src/adapters/drizzle-claimant-wallet-resolver.adapter.ts,
 *   nodes/operator/app/src/app/api/v1/public/attribution/epochs/[id]/distribution/route.ts
 * @public
 */

import { randomBytes } from "node:crypto";

import { buildEpochDistribution } from "@cogni/aragon-osx";
import {
  DrizzleAttributionAdapter,
  DrizzleClaimantWalletResolver,
} from "@cogni/db-client";
import { users } from "@cogni/db-schema";
import {
  seedClosedEpoch,
  TEST_NODE_ID,
  TEST_SCOPE_ID,
} from "@tests/_fixtures/attribution/seed-attribution";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  epochTokenBudgetFromStatement,
  toFinalizedEpochStatement,
} from "@/features/governance/publish-epoch/build-distribution";
import { getScopeId } from "@/shared/config/repoSpec.server";

// The public route reads via getContainer().attributionStore and wrapPublicRoute's
// lazy init reads getContainer().config. We mock ONLY the container so we exercise
// the REAL route handler + wrapper against a REAL Postgres-backed adapter (component
// tier), without constructing the full DI container (Temporal/EVM/Privy) in this env.
// The adapter is built lazily off the testcontainer seed DB, scoped to the operator's
// repo-spec scope_id — exactly what the real container binds attributionStore to.
vi.mock("@/bootstrap/container", async () => {
  const { DrizzleAttributionAdapter } = await import("@cogni/db-client");
  const { getSeedDb } = await import("@tests/_fixtures/db/seed-client");
  const { getScopeId: realGetScopeId } = await import(
    "@/shared/config/repoSpec.server"
  );
  const { makeLogger } = await import("@/shared/observability");
  const { SystemClock } = await import("@/adapters/server");
  let cached: Record<string, unknown> | null = null;
  return {
    getContainer: () => {
      if (!cached) {
        cached = {
          attributionStore: new DrizzleAttributionAdapter(
            getSeedDb(),
            realGetScopeId()
          ),
          log: makeLogger({ service: "cogni-template", nodeId: "test" }),
          clock: new SystemClock(),
          config: {
            unhandledErrorPolicy: "rethrow",
            rateLimitBypass: {
              enabled: true,
              headerName: "x-stack-test",
              headerValue: "1",
            },
            DEPLOY_ENVIRONMENT: "test",
          },
        };
      }
      return cached;
    },
  };
});

/** Generates a valid lowercase EVM wallet address (0x + 40 hex). */
function generateWalletAddress(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

/**
 * Seed a real `users` row with the given id + wallet_address. This is the
 * LOAD-BEARING prerequisite the dev seed omits: DrizzleClaimantWalletResolver
 * resolves `user:<id>` → users.wallet_address (or a provider='wallet' binding);
 * without a wallet every claimant resolves null → no distribution.
 */
async function seedUserWithWallet(
  db: ReturnType<typeof getSeedDb>,
  id: string,
  walletAddress: string
): Promise<void> {
  await db
    .insert(users)
    .values({ id, name: `Walk Test User ${id}`, walletAddress })
    .onConflictDoNothing({ target: users.id });
}

/**
 * Seed a real `users` row WITHOUT a wallet (the unlinked claimant). The resolver
 * resolves user_id but finds no wallet → `claimants_unresolved` blocker.
 */
async function seedUserNoWallet(
  db: ReturnType<typeof getSeedDb>,
  id: string
): Promise<void> {
  await db
    .insert(users)
    .values({ id, name: `Walk Test User ${id}` })
    .onConflictDoNothing({ target: users.id });
}

// The seedClosedEpoch fixture emits two statement lines keyed to literal users:
//   claimant_key "user:user-1" (credit_amount 8000)
//   claimant_key "user:user-2" (credit_amount 2000)
// We seed user-1 WITH a wallet (resolves → leaf) and user-2 WITHOUT (unresolved).
const RESOLVED_USER_ID = "user-1";
const UNLINKED_USER_ID = "user-2";
const RESOLVED_CLAIMANT_KEY = `user:${RESOLVED_USER_ID}`;
const UNLINKED_CLAIMANT_KEY = `user:${UNLINKED_USER_ID}`;

// On-chain refs the build helper needs (no chain reads happen — pure mapping).
const TOKEN_ADDRESS =
  "0x1111111111111111111111111111111111111111" as `0x${string}`;
const CHAIN_ID = 8453;

describe("publish-epoch off-chain path (Component)", () => {
  const db = getSeedDb();
  // Adapter scoped to TEST_SCOPE_ID for the service + store assertions (steps 1-3).
  const adapter = new DrizzleAttributionAdapter(db, TEST_SCOPE_ID);
  const resolver = new DrizzleClaimantWalletResolver(db);

  let resolvedWallet: string;

  beforeAll(async () => {
    resolvedWallet = generateWalletAddress();
    // LOAD-BEARING: give the resolved claimant a wallet; leave the other unlinked.
    await seedUserWithWallet(db, RESOLVED_USER_ID, resolvedWallet);
    await seedUserNoWallet(db, UNLINKED_USER_ID);
  });

  // ── Step 1 + 2: resolver + buildEpochDistribution ───────────────────────
  describe("buildEpochDistribution over a finalized, admin-signed epoch", () => {
    it("resolved claimant gets a leaf; unlinked claimant is excluded as claimants_unresolved", async () => {
      // Step 1: seed a FINALIZED epoch + signed statement, scoped to TEST_SCOPE_ID.
      const { epoch, statement } = await seedClosedEpoch(adapter, {
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        epochOffset: 200,
      });
      expect(epoch.status).toBe("finalized");

      // Map the signed DB statement → buildEpochDistribution inputs using the
      // SAME production helpers the publish-epoch route uses.
      const finalized = toFinalizedEpochStatement(epoch, statement, {
        tokenAddress: TOKEN_ADDRESS,
        chainId: CHAIN_ID,
      });
      const budget = epochTokenBudgetFromStatement(statement);
      expect(budget).toBeGreaterThan(0n);

      // Step 2: build the distribution against the real resolver.
      const { distribution, blockers, unresolvedClaimantKeys } =
        await buildEpochDistribution(finalized, budget, resolver);

      // Non-empty distribution: the resolved claimant got a leaf.
      expect(distribution).not.toBeNull();
      if (!distribution) throw new Error("expected a distribution");
      expect(distribution.leaves.length).toBe(1);

      const leaf = distribution.leaves[0];
      expect(leaf?.claimantKey).toBe(RESOLVED_CLAIMANT_KEY);
      // account resolved to the seeded wallet (case-insensitive compare).
      expect(leaf?.account.toLowerCase()).toBe(resolvedWallet.toLowerCase());
      expect(leaf?.amount).toBeGreaterThan(0n);
      expect(distribution.merkleRoot).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // The UNLINKED claimant (no wallet) is excluded + surfaced as a blocker.
      expect(unresolvedClaimantKeys).toContain(UNLINKED_CLAIMANT_KEY);
      expect(unresolvedClaimantKeys).not.toContain(RESOLVED_CLAIMANT_KEY);
      expect(blockers.some((b) => b.code === "claimants_unresolved")).toBe(true);
    });
  });

  // ── Step 3: P3 manifest store round-trip ────────────────────────────────
  describe("manifest store round-trip", () => {
    it("upsertDistributionManifest → getDistributionClaimForAccount returns the right leaf", async () => {
      const { epoch, statement } = await seedClosedEpoch(adapter, {
        nodeId: TEST_NODE_ID,
        scopeId: TEST_SCOPE_ID,
        epochOffset: 201,
      });

      const finalized = toFinalizedEpochStatement(epoch, statement, {
        tokenAddress: TOKEN_ADDRESS,
        chainId: CHAIN_ID,
      });
      const budget = epochTokenBudgetFromStatement(statement);
      const { distribution } = await buildEpochDistribution(
        finalized,
        budget,
        resolver
      );
      if (!distribution) throw new Error("expected a distribution");

      // Persist the manifest (header + leaves), distributorAddress still null —
      // mirrors the publish-epoch route's upsert exactly.
      const manifest = await adapter.upsertDistributionManifest({
        nodeId: distribution.nodeId,
        scopeId: distribution.scopeId,
        epochId: epoch.id,
        distributionId: distribution.distributionId,
        statementHash: distribution.statementHash,
        merkleRoot: distribution.merkleRoot,
        chainId: distribution.chainId,
        tokenAddress: distribution.tokenAddress,
        distributionAmount: distribution.distributionAmount,
        totalAllocated: distribution.totalAllocated,
        distributorAddress: null,
        leaves: distribution.leaves.map((l) => ({
          index: l.index,
          claimantKey: l.claimantKey,
          account: l.account,
          amount: l.amount,
          leafHash: l.leafHash,
          proof: [...l.proof],
        })),
      });
      expect(manifest.merkleRoot).toBe(distribution.merkleRoot);
      expect(manifest.distributorAddress).toBeNull();

      // Read it back by the resolved account (case-insensitive on the address).
      const expectedLeaf = distribution.leaves[0];
      if (!expectedLeaf) throw new Error("expected a leaf");

      const claim = await adapter.getDistributionClaimForAccount(
        epoch.id,
        resolvedWallet
      );
      expect(claim).not.toBeNull();
      if (!claim) throw new Error("expected a claim");

      expect(claim.epochId).toBe(epoch.id);
      expect(claim.merkleRoot).toBe(distribution.merkleRoot);
      expect(claim.chainId).toBe(CHAIN_ID);
      expect(claim.tokenAddress).toBe(TOKEN_ADDRESS);
      expect(claim.distributorAddress).toBeNull();
      // The leaf payload round-trips: index, amount, proof match what was built.
      expect(claim.leaf.index).toBe(expectedLeaf.index);
      expect(claim.leaf.account.toLowerCase()).toBe(
        resolvedWallet.toLowerCase()
      );
      expect(claim.leaf.amount).toBe(expectedLeaf.amount);
      expect([...claim.leaf.proof]).toEqual([...expectedLeaf.proof]);

      // Unknown account → no leaf in this manifest.
      const missing = await adapter.getDistributionClaimForAccount(
        epoch.id,
        generateWalletAddress()
      );
      expect(missing).toBeNull();
    });
  });

  // ── Step 4: public distribution route ───────────────────────────────────
  describe("GET /api/v1/public/attribution/epochs/[id]/distribution", () => {
    // The public route reads via getContainer().attributionStore, which is scoped
    // to the OPERATOR's repo-spec scope_id (not TEST_SCOPE_ID). So we seed +
    // persist this epoch under getScopeId() so the container-scoped store sees it.
    const operatorScopeId = getScopeId();
    const routeAdapter = new DrizzleAttributionAdapter(db, operatorScopeId);

    let routeEpochId: bigint;
    let GET: (
      req: NextRequest,
      ctx: { params: Promise<{ id: string }> }
    ) => Promise<Response>;

    beforeAll(async () => {
      // Import the route handler lazily — it pulls the DI container, which must
      // resolve AFTER the testcontainer env (DATABASE_SERVICE_URL/APP_ENV) is set.
      ({ GET } = await import(
        "@/app/api/v1/public/attribution/epochs/[id]/distribution/route"
      ));

      const { epoch, statement } = await seedClosedEpoch(routeAdapter, {
        nodeId: TEST_NODE_ID,
        scopeId: operatorScopeId,
        epochOffset: 202,
      });
      routeEpochId = epoch.id;

      const finalized = toFinalizedEpochStatement(epoch, statement, {
        tokenAddress: TOKEN_ADDRESS,
        chainId: CHAIN_ID,
      });
      const budget = epochTokenBudgetFromStatement(statement);
      const { distribution } = await buildEpochDistribution(
        finalized,
        budget,
        resolver
      );
      if (!distribution) throw new Error("expected a distribution");

      await routeAdapter.upsertDistributionManifest({
        nodeId: distribution.nodeId,
        scopeId: distribution.scopeId,
        epochId: epoch.id,
        distributionId: distribution.distributionId,
        statementHash: distribution.statementHash,
        merkleRoot: distribution.merkleRoot,
        chainId: distribution.chainId,
        tokenAddress: distribution.tokenAddress,
        distributionAmount: distribution.distributionAmount,
        totalAllocated: distribution.totalAllocated,
        distributorAddress: null,
        leaves: distribution.leaves.map((l) => ({
          index: l.index,
          claimantKey: l.claimantKey,
          account: l.account,
          amount: l.amount,
          leafHash: l.leafHash,
          proof: [...l.proof],
        })),
      });
    });

    function makeReq(epochId: string, account?: string): NextRequest {
      const base = `http://localhost:3000/api/v1/public/attribution/epochs/${epochId}/distribution`;
      const url = account
        ? `${base}?account=${encodeURIComponent(account)}`
        : base;
      // x-stack-test bypass header matches the mocked container's rateLimitBypass
      // config so the shared token-bucket limiter never flakes this suite.
      return new NextRequest(url, {
        method: "GET",
        headers: { "x-stack-test": "1" },
      });
    }

    it("serves the resolved claimant's proof for a finalized epoch", async () => {
      const res = await GET(makeReq(routeEpochId.toString(), resolvedWallet), {
        params: Promise.resolve({ id: routeEpochId.toString() }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claim).not.toBeNull();
      expect(body.claim.epochId).toBe(routeEpochId.toString());
      expect(body.claim.account.toLowerCase()).toBe(
        resolvedWallet.toLowerCase()
      );
      expect(body.claim.root).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(typeof body.claim.amount).toBe("string");
      expect(BigInt(body.claim.amount)).toBeGreaterThan(0n);
      expect(Array.isArray(body.claim.proof)).toBe(true);
      expect(body.claim.distributor).toBeNull();
      expect(body.claim.chainId).toBe(CHAIN_ID);
    });

    it("404s for an unknown account on a finalized epoch", async () => {
      const res = await GET(
        makeReq(routeEpochId.toString(), generateWalletAddress()),
        { params: Promise.resolve({ id: routeEpochId.toString() }) }
      );
      expect(res.status).toBe(404);
    });

    it("404s for a non-finalized (unknown) epoch", async () => {
      const unknownEpochId = "999999999";
      const res = await GET(makeReq(unknownEpochId, resolvedWallet), {
        params: Promise.resolve({ id: unknownEpochId }),
      });
      expect(res.status).toBe(404);
    });
  });
});
