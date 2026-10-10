// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/finalize/run-finalize-epoch`
 * Purpose: Runtime-agnostic epoch finalization — sign-verify → atomic off-chain finalize → R3 cumulative fold. Extracted from scheduler-worker/activities/ledger.ts so it runs identically in a Temporal activity OR synchronously in a node's own HTTP route (story.5007 finalize-in-process).
 * Scope: One pure-DI async function + its fold/guard closures. Performs I/O only through the injected `AttributionStore` and (optional) distribution-config resolver + wallet resolver. Does not send on-chain transactions, dispatch Temporal, read env/repo-spec, or import framework or Node built-ins (platform:neutral) — it only BUILDS + persists the manifest.
 * Invariants:
 *   - EPOCH_FINALIZE_IDEMPOTENT: already-finalized epoch → repair via finalizeEpochAtomic, returns existing statement.
 *   - FINALIZE_CLAIMANT_AWARE: loads locked claimant rows, dispatches the pinned allocator, explodes to claimant allocations.
 *   - FINALIZE_BUILDS_CUMULATIVE_ROOT (R3): the SINGLE finalize signature folds this epoch's claimant deltas onto the prior cumulative manifest and persists the new root + per-epoch mint delta. Never sends an on-chain tx.
 *   - FREEZE (bug.5022): a persisted manifest is IMMUTABLE — repair/re-finalize preserves it, never re-folds (a re-fold → new root for an already-published epoch → double-mint).
 *   - bug.5020 execute-guard: a non-production runtime refuses to build a distribution against the production Cogni DAO; fail-closed on a null emissions holder (baked-fallback path).
 *   - FOLD_NEVER_UNDOES_FINALIZE: the cumulative fold runs AFTER the atomic off-chain finalize commits, in try/catch — a fold failure leaves the signed statement intact.
 * Side-effects: IO (AttributionStore DB, viem EIP-712 verification, optional HTTP/in-process config resolver).
 * Links: docs/spec/attribution-ledger.md, packages/aragon-osx/src/epoch-distribution-service.ts
 * @public
 */

import {
  buildCumulativeEpochDistribution,
  type ClaimantWalletResolver,
  type DaoTokenCumulativeDistribution,
  type FinalizedEpochStatement,
  type HexAddress,
  type PriorCumulativeBalance,
} from "@cogni/aragon-osx";
import {
  type ActorBeneficiaryWalletResolver,
  applyReceiptWeightOverrides,
  type AttributionStore,
  buildEIP712TypedData,
  buildReceiptWeightOverrideSnapshots,
  claimantKey,
  computeApproverSetHash,
  computeAttributionStatementLines,
  computeFinalClaimantAllocationSetHash,
  explodeToClaimants,
  parseEIP712DeploymentEnvironment,
  type ReceiptClaimantsRecord,
  type ReceiptUnitWeight,
  type SubjectOverride,
  toReviewSubjectOverrides,
} from "@cogni/attribution-ledger";
import { dispatchAllocator } from "@cogni/attribution-pipeline-contracts";
import { verifyTypedData } from "viem";

import type { DefaultRegistries } from "../registry";
import { buildActorCumulativeFold } from "./actor-cumulative-fold";

/**
 * 18-decimal base-unit scale for the GovernanceERC20. The per-epoch mint delta
 * maps 1 signed credit → 1 whole token (× 10^18 base units).
 */
const TOKEN_BASE_UNITS = 10n ** 18n;

/**
 * The PRODUCTION Cogni DAO / emissions-holder address. The bug.5020 execute-guard
 * refuses to build any distribution against this address on a non-production runtime,
 * so a candidate/preview deploy can never mint into or set a root for production
 * governance — defense-in-depth behind the per-node-spec seam.
 */
const PROD_COGNI_DAO_ADDRESS =
  "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6".toLowerCase();

/**
 * Codes for CLIENT/REQUEST-STATE finalize failures — the caller can fix these (wrong
 * epoch state, unknown signer, invalid signature). The finalize route maps them to HTTP
 * 422, keeping them OUT of the 500 "internal" alarm bucket (FAULT_PARTY_BEFORE_BUCKET,
 * error-handling.md). Genuine server faults (data-integrity mismatch, DB failure) throw
 * a plain Error → 500, so `internal` stays the alarm, not the dump.
 */
export type FinalizeEpochErrorCode =
  | "epoch_not_found"
  | "epoch_not_in_review"
  | "config_not_locked"
  | "no_approvers"
  | "signer_not_approver"
  | "no_pool_components"
  | "missing_base_issuance"
  | "no_locked_claimants"
  | "no_claimant_allocations"
  | "signature_invalid";

/** A finalize failure the caller can fix (bad request state / signer / signature). */
export class FinalizeEpochError extends Error {
  readonly code: FinalizeEpochErrorCode;
  constructor(code: FinalizeEpochErrorCode, message: string) {
    super(message);
    this.name = "FinalizeEpochError";
    this.code = code;
  }
}

/** Type guard — the route uses this to translate to HTTP 422 (never string-matches). */
export function isFinalizeEpochError(err: unknown): err is FinalizeEpochError {
  return err instanceof FinalizeEpochError;
}

/** Structural logger — pino-compatible, avoids a pino dep in this neutral package. */
export interface FinalizeLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Reads the FINALIZING node's distribution config (token / emissions holder /
 * distributor) from that node's OWN repo-spec — bug.5020. Structural port so BOTH
 * the worker's HTTP `DistributionConfigHttpClient` AND the operator app's in-process
 * gateway resolver are assignable without this package depending on either runtime.
 */
export interface FinalizeDistributionConfigResolver {
  /**
   * @returns `distribution: null` ⇔ distributions not activated for this node —
   *   the fold no-ops. @throws (retryable) on a transient failure — the caller
   *   falls back to the baked config for its own node (a blip must never masquerade
   *   as "inactive").
   */
  resolveForNode(nodeId: string): Promise<{
    readonly distribution: {
      readonly tokenAddress: string | null;
      readonly distributorAddress: string | null;
      readonly emissionsHolderAddress: string | null;
    } | null;
    readonly reason?: string;
  }>;
}

/**
 * Dependencies injected into `runFinalizeEpoch`. Mirrors the finalize subset of the
 * worker's `AttributionActivityDeps` (minus `sourceRegistrations`, unused at finalize)
 * so the same deps object satisfies both the Temporal activity and the node route.
 */
export interface RunFinalizeEpochDeps {
  readonly attributionStore: AttributionStore;
  readonly registries: DefaultRegistries;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly chainId: number;
  /** GovernanceERC20 token address; null until the node activates distributions. */
  readonly tokenAddress: string | null;
  /** The ONE per-node cumulative distributor recorded at R2 activation; null until recorded. */
  readonly distributorAddress: string | null;
  /**
   * DAO that mints + owns the distributor (governance.emissions_holder), baked from
   * the runtime's OWN repo-spec; null until activated. Lets the bug.5020 execute-guard
   * assert the governance target on the baked-fallback path (no gateway).
   */
  readonly emissionsHolderAddress?: string | null;
  /**
   * Read-only resolver: attribution claimant key → contributor wallet. Null disables
   * cumulative-root building (off-chain ledger still finalizes).
   */
  readonly walletResolver: ClaimantWalletResolver | null;
  /** Actor beneficiary resolver; reads only frozen beneficiary actor bindings. */
  readonly actorWalletResolver?: ActorBeneficiaryWalletResolver | null;
  /**
   * bug.5020 per-node distribution-config gateway. Resolves the FINALIZING node's
   * governance from ITS OWN repo-spec (SPECS_GIT_AUTHORITATIVE). Null (or a transient
   * failure) falls back to the baked config above for the runtime's OWN node only.
   */
  readonly distributionConfigClient?: FinalizeDistributionConfigResolver | null;
  /**
   * Server-injected deploy environment for EIP-712 v2 and the bug.5020 execute
   * guard. Missing/unsupported values abort finalization before any mutation.
   * Explicitly `| undefined` keeps misconfiguration representable so the
   * runtime guard—not a client/default—owns the fail-closed decision.
   */
  readonly deploymentEnvironment?: string | undefined;
  readonly logger: FinalizeLogger;
}

/** Input for finalizeEpoch. */
export interface FinalizeEpochInput {
  readonly epochId: string; // bigint serialized
  readonly signature: string; // EIP-712 hex
  readonly signerAddress: string; // from SIWE session
}

/** Output from finalizeEpoch. */
export interface FinalizeEpochOutput {
  readonly statementId: string;
  readonly poolTotalCredits: string; // bigint serialized
  readonly finalAllocationSetHash: string;
  readonly statementLineCount: number;
  /**
   * Cumulative distribution produced by the SAME finalize signature (R3). Null when
   * distributions are not activated or no wallet-resolved cumulative balance remains.
   * When present, the per-epoch on-chain action is: DAO.mint(mintDelta) into the
   * existing distributor + distributor.setMerkleRoot(merkleRoot). BUILT, never sent.
   */
  readonly cumulativeDistribution: {
    readonly distributionId: string;
    readonly merkleRoot: string;
    readonly mintDelta: string; // bigint serialized — DAO mints exactly this
    readonly cumulativeTotal: string; // bigint serialized — total supply to date
    readonly leafCount: number;
    readonly tokenAddress: string;
    readonly chainId: number;
    /** Existing per-node distributor (null until R2 activation records it). */
    readonly distributorAddress: string | null;
  } | null;
}

function toEvaluationPayloadMap(
  evaluations: ReadonlyArray<{
    readonly evaluationRef: string;
    readonly payloadJson: Record<string, unknown> | null;
  }>
): ReadonlyMap<string, Record<string, unknown>> {
  const payloads = new Map<string, Record<string, unknown>>();
  for (const evaluation of evaluations) {
    if (evaluation.payloadJson) {
      payloads.set(evaluation.evaluationRef, evaluation.payloadJson);
    }
  }
  return payloads;
}

/**
 * Finalize an epoch: verify the approver's EIP-712 signature, atomically write the
 * off-chain statement + signature, then fold this epoch's deltas onto the cumulative
 * distribution manifest (R3). Idempotent — a re-POST repairs. Runtime-agnostic:
 * called from the Temporal activity (worker) and the node's finalize route (in-process).
 */
export async function runFinalizeEpoch(
  deps: RunFinalizeEpochDeps,
  input: FinalizeEpochInput
): Promise<FinalizeEpochOutput> {
  const {
    attributionStore,
    registries,
    nodeId,
    scopeId,
    chainId,
    tokenAddress,
    distributorAddress: repoSpecDistributorAddress,
    emissionsHolderAddress: repoSpecEmissionsHolderAddress,
    walletResolver,
    actorWalletResolver,
    distributionConfigClient,
    deploymentEnvironment: unvalidatedDeploymentEnvironment,
    logger,
  } = deps;

  // SIGNATURE_DEPLOYMENT_BOUND: this is server-injected runtime config, never
  // finalize request input. Missing/unknown values abort before any mutation.
  const deploymentEnvironment = parseEIP712DeploymentEnvironment(
    unvalidatedDeploymentEnvironment
  );

  /**
   * bug.5020 execute-guard: fail-closed refusal to build a distribution against the
   * PRODUCTION Cogni DAO from a non-production runtime. Thrown inside the fold, which
   * the finalize body wraps in try/catch — a trip leaves the off-chain statement
   * finalized and simply skips the on-chain manifest (safe no-op), loudly logged.
   */
  function assertNotProdGovernanceOnNonProd(
    emissionsHolderAddress: string | null,
    epochId: bigint
  ): void {
    if (deploymentEnvironment === "production") return;
    if (
      emissionsHolderAddress &&
      emissionsHolderAddress.toLowerCase() === PROD_COGNI_DAO_ADDRESS
    ) {
      throw new Error(
        `[bug.5020 execute-guard] refusing to build a distribution against the PRODUCTION Cogni DAO ${emissionsHolderAddress} from a non-production runtime (DEPLOY_ENVIRONMENT=${deploymentEnvironment ?? "<unset>"}, epoch ${epochId.toString()})`
      );
    }
    // NULL-BLIND FAIL-CLOSED: this guard runs AFTER the tokenAddress gate, i.e. we are
    // about to build a real distribution. On a non-prod runtime a null emissionsHolder
    // means the baked-fallback path (the gateway didn't authoritatively give us the DAO)
    // — we CANNOT prove the governance target is not prod, so we refuse rather than trust
    // a baked identity. The legitimate non-prod path (own spec) no-ops earlier on a null
    // tokenAddress and never reaches here; the authoritative gateway always supplies a
    // non-null holder.
    if (emissionsHolderAddress === null) {
      throw new Error(
        `[bug.5020 execute-guard] refusing to build a distribution with an UNKNOWN emissions holder (baked-fallback path) from a non-production runtime (DEPLOY_ENVIRONMENT=${deploymentEnvironment ?? "<unset>"}, epoch ${epochId.toString()}) — cannot prove the governance target is not the production DAO`
      );
    }
  }

  /**
   * Resolve the effective per-node distribution config for THIS runtime's node at fold
   * time (bug.5020). Order: (1) the per-node gateway (authoritative — the finalizing
   * node's own repo-spec); (2) on a transient gateway failure, the baked config (prod
   * continuity — a network blip must never skip a real distribution); (3) when the
   * gateway is unwired (null client), the baked config. A gateway that authoritatively
   * reports `distribution: null` (not activated) returns nulls here — NOT the baked
   * fallback — so a non-activated node correctly no-ops.
   */
  async function resolveEffectiveDistributionConfig(epochId: bigint): Promise<{
    readonly tokenAddress: string | null;
    readonly distributorAddress: string | null;
    readonly emissionsHolderAddress: string | null;
  }> {
    const baked = {
      tokenAddress,
      distributorAddress: repoSpecDistributorAddress,
      emissionsHolderAddress: repoSpecEmissionsHolderAddress ?? null,
    };
    if (!distributionConfigClient) {
      return baked;
    }
    try {
      const resolved = await distributionConfigClient.resolveForNode(nodeId);
      if (resolved.distribution) {
        return {
          tokenAddress: resolved.distribution.tokenAddress,
          distributorAddress: resolved.distribution.distributorAddress,
          emissionsHolderAddress: resolved.distribution.emissionsHolderAddress,
        };
      }
      // Authoritative "not activated" — do NOT fall back to baked config.
      logger.info(
        { epochId: epochId.toString(), nodeId, reason: resolved.reason },
        "Per-node distribution config inactive — cumulative fold will no-op"
      );
      return {
        tokenAddress: null,
        distributorAddress: null,
        emissionsHolderAddress: null,
      };
    } catch (err) {
      // TRANSIENT_IS_ERROR_NOT_NULL: the gateway threw (5xx/503/network). Never undo
      // the off-chain finalize; fall back to the baked config for our own node.
      logger.warn(
        {
          epochId: epochId.toString(),
          nodeId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Per-node distribution config fetch failed — falling back to baked config (prod continuity)"
      );
      return baked;
    }
  }

  /**
   * R3 — build + persist the cumulative distribution from a just-finalized epoch.
   * No-ops (returns null) when distributions are not activated (no tokenAddress or
   * resolver) or no wallet-resolved cumulative balance remains — the off-chain
   * ledger finalize already succeeded and must not be undone.
   */
  async function buildAndPersistCumulativeDistribution(args: {
    readonly epochId: bigint;
    readonly statementId: string;
    readonly finalAllocationSetHash: string;
    readonly statementLines: ReadonlyArray<{
      readonly claimant_key: string;
      readonly credit_amount: string;
      readonly receipt_ids: readonly string[];
    }>;
    readonly actorFoldInputs?: {
      readonly receiptWeights: readonly ReceiptUnitWeight[];
      readonly lockedClaimants: readonly ReceiptClaimantsRecord[];
      readonly overrides: readonly SubjectOverride[];
    };
  }): Promise<FinalizeEpochOutput["cumulativeDistribution"]> {
    // FREEZE (bug.5022): once an epoch's manifest is persisted it is IMMUTABLE. A repair /
    // re-finalize must never re-fold and OVERWRITE it — a re-fold that picks up a newly
    // wallet-linked contributor produces a NEW merkle root for an epoch that may already be
    // published on-chain, which the client-side "already-live root" guard no longer
    // recognizes → a second DAO.mint(delta) re-opens the double-mint that stranded tokens on
    // Base. The first finalize builds the manifest; every later call preserves it. Late
    // resolutions flow into the NEXT epoch's cumulative fold (never a retro-overwrite).
    const existingManifest =
      await attributionStore.getDistributionManifestForEpoch(args.epochId);
    if (existingManifest) {
      const frozenLeaves = await attributionStore.getDistributionLeavesForEpoch(
        args.epochId
      );
      logger.info(
        {
          epochId: args.epochId.toString(),
          nodeId,
          merkleRoot: `${existingManifest.merkleRoot.slice(0, 12)}...`,
          leafCount: frozenLeaves.length,
        },
        "Cumulative distribution FROZEN — manifest already persisted; preserving without re-fold (bug.5022)"
      );
      return {
        distributionId: existingManifest.distributionId,
        merkleRoot: existingManifest.merkleRoot,
        // No new mint on a preserved manifest — this repair emits nothing to publish.
        mintDelta: "0",
        cumulativeTotal: existingManifest.distributionAmount.toString(),
        leafCount: frozenLeaves.length,
        tokenAddress: existingManifest.tokenAddress,
        chainId: existingManifest.chainId,
        distributorAddress: existingManifest.distributorAddress,
      };
    }

    // bug.5020: resolve the finalizing node's governance from ITS OWN repo-spec via the
    // gateway — the runtime bakes no node's governance identity. The wallet resolver is
    // DB-backed (not spec-derived) and stays from deps, gated on a token.
    const effective = await resolveEffectiveDistributionConfig(args.epochId);
    const effectiveTokenAddress = effective.tokenAddress;
    const effectiveDistributorAddress = effective.distributorAddress;

    if (!effectiveTokenAddress || !walletResolver) {
      logger.info(
        { epochId: args.epochId.toString(), nodeId },
        "Cumulative distribution skipped — distributions not activated (no tokenAddress/walletResolver)"
      );
      return null;
    }

    // bug.5020 execute-guard (defense-in-depth): a non-production runtime must never build
    // a distribution against the production Cogni DAO, even via a baked-spec fallback.
    assertNotProdGovernanceOnNonProd(
      effective.emissionsHolderAddress,
      args.epochId
    );

    // Prior cumulative balances = the most-recent persisted cumulative manifest's
    // per-account leaf amounts (each cumulative leaf carries the account's
    // cumulative-to-date). We find the highest epoch id BEFORE this one that has a
    // persisted manifest. No new store method: enumerate epochs and read manifests.
    const [allEpochs, targetEpoch] = await Promise.all([
      attributionStore.listEpochs(nodeId),
      attributionStore.getEpoch(args.epochId),
    ]);
    if (!targetEpoch) {
      throw new Error(`Distribution target epoch ${args.epochId} disappeared`);
    }
    const priorEpochIds = allEpochs
      .filter(
        (candidate) =>
          candidate.periodEnd.getTime() <= targetEpoch.periodStart.getTime()
      )
      .sort((a, b) => {
        const byPeriodEnd = b.periodEnd.getTime() - a.periodEnd.getTime();
        if (byPeriodEnd !== 0) return byPeriodEnd;
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      })
      .map((candidate) => candidate.id);

    let priorManifest: Awaited<
      ReturnType<typeof attributionStore.getDistributionManifestForEpoch>
    > = null;
    let priorLeaves: Awaited<
      ReturnType<typeof attributionStore.getDistributionLeavesForEpoch>
    > = [];
    for (const priorEpochId of priorEpochIds) {
      const manifest =
        await attributionStore.getDistributionManifestForEpoch(priorEpochId);
      if (manifest) {
        priorManifest = manifest;
        priorLeaves =
          await attributionStore.getDistributionLeavesForEpoch(priorEpochId);
        break;
      }
    }

    const priorCumulative: PriorCumulativeBalance[] = priorLeaves.map(
      (leaf) => ({
        account: leaf.account as HexAddress,
        cumulativeAmount: leaf.amount,
      })
    );

    const distributorAddress =
      priorManifest?.distributorAddress ??
      (await attributionStore.getDistributionManifestForEpoch(args.epochId))
        ?.distributorAddress ??
      // R2↔R3 seam: the FIRST epoch has no prior/current manifest, so fall back to
      // the ONE per-node distributor R2 recorded in the finalizing node's repo-spec at
      // activation (resolved per-node via the gateway; baked value as fallback).
      effectiveDistributorAddress ??
      null;

    // The per-epoch mint delta is THIS epoch's poolTotal in base units
    // (poolTotalCredits × 10^18), mapped 1 credit → 1 whole token.
    const poolTotalCredits = args.statementLines.reduce(
      (sum, line) => sum + BigInt(line.credit_amount),
      0n
    );
    const mintDelta = poolTotalCredits * TOKEN_BASE_UNITS;

    const finalized: FinalizedEpochStatement = {
      distributionId: `epoch-${args.epochId.toString()}`,
      nodeId,
      scopeId,
      statementHash: args.finalAllocationSetHash,
      chainId,
      tokenAddress: effectiveTokenAddress as HexAddress,
      lines: args.statementLines.map((line) => ({
        claimantKey: line.claimant_key,
        creditAmount: BigInt(line.credit_amount),
        receiptIds: line.receipt_ids,
      })),
    };

    const [
      currentActorAllocations,
      unfoldedActorAllocations,
      pendingLiabilities,
    ] = await Promise.all([
      attributionStore.listActorContributionAllocationsForEpoch(args.epochId),
      attributionStore.listUnfoldedActorContributionAllocationsForEpoch(
        args.epochId
      ),
      attributionStore.listPendingActorDistributionLiabilities(args.epochId),
    ]);
    const actorAware =
      currentActorAllocations.length > 0 || pendingLiabilities.length > 0;

    let distribution: DaoTokenCumulativeDistribution | null;
    let blockers: readonly { readonly code: string }[] = [];
    let unresolvedClaimantKeys: readonly string[] = [];
    let actorLiabilities: Parameters<
      typeof attributionStore.insertActorDistributionLiabilities
    >[0] = [];
    let actorSettlements: NonNullable<
      Parameters<
        typeof attributionStore.upsertDistributionManifest
      >[0]["actorSettlements"]
    > = [];

    if (actorAware) {
      if (!actorWalletResolver) {
        throw new Error(
          "Actor allocations require the actor beneficiary wallet resolver"
        );
      }
      let actorFoldInputs = args.actorFoldInputs;
      if (!actorFoldInputs) {
        const repairEpoch = await attributionStore.getEpoch(args.epochId);
        if (!repairEpoch?.allocationAlgoRef) {
          throw new Error(
            "Actor fold repair requires the locked allocator config"
          );
        }
        const [lockedClaimants, selections, overrideRecords, evaluations] =
          await Promise.all([
            attributionStore.loadLockedClaimants(args.epochId),
            attributionStore.getSelectedReceiptsForAllocation(args.epochId),
            attributionStore.getReviewSubjectOverridesForEpoch(args.epochId),
            attributionStore.getEvaluationsForEpoch(args.epochId, "locked"),
          ]);
        const rawWeights = await dispatchAllocator(
          registries.allocators,
          repairEpoch.allocationAlgoRef,
          {
            receipts: selections,
            weightConfig: repairEpoch.weightConfig,
            evaluations: toEvaluationPayloadMap(evaluations),
            profileConfig: null,
          }
        );
        const overrides = toReviewSubjectOverrides(overrideRecords);
        actorFoldInputs = {
          receiptWeights: applyReceiptWeightOverrides(rawWeights, overrides),
          lockedClaimants,
          overrides,
        };
      }
      const actorFold = await buildActorCumulativeFold({
        distributionId: finalized.distributionId,
        nodeId,
        scopeId,
        foldEpochId: args.epochId,
        statementHash: args.finalAllocationSetHash,
        chainId,
        tokenAddress: effectiveTokenAddress as HexAddress,
        totalTokenAmount: mintDelta,
        receiptWeights: actorFoldInputs.receiptWeights,
        lockedClaimants: actorFoldInputs.lockedClaimants,
        overrides: actorFoldInputs.overrides,
        currentActorAllocations,
        unfoldedActorAllocations,
        pendingLiabilities,
        priorCumulative,
        legacyWalletResolver: walletResolver,
        actorWalletResolver,
      });
      distribution = actorFold.distribution;
      actorLiabilities = actorFold.liabilities;
      actorSettlements = actorFold.settlements;
      unresolvedClaimantKeys = actorFold.unresolvedClaimantKeys;
    } else {
      const legacy = await buildCumulativeEpochDistribution(
        finalized,
        mintDelta,
        priorCumulative,
        walletResolver
      );
      distribution = legacy.distribution;
      blockers = legacy.blockers;
      unresolvedClaimantKeys = legacy.unresolvedClaimantKeys;
    }

    if (!distribution) {
      if (actorLiabilities.length > 0) {
        await attributionStore.insertActorDistributionLiabilities(
          actorLiabilities
        );
      }
      logger.warn(
        {
          epochId: args.epochId.toString(),
          blockers: blockers.map((b) => b.code),
          unresolvedClaimantKeys,
        },
        "Cumulative distribution not built — no wallet-resolved cumulative balance"
      );
      return null;
    }

    // Persist the cumulative manifest (header + cumulative leaves). The
    // distributionAmount column holds the cumulative supply distributed to date;
    // totalAllocated holds the same (every leaf is wallet-backed). The
    // distributorAddress carries forward from the prior manifest (R2 records it).
    await attributionStore.upsertDistributionManifest({
      nodeId: distribution.nodeId,
      scopeId: distribution.scopeId,
      epochId: args.epochId,
      distributionId: distribution.distributionId,
      statementHash: distribution.statementHash,
      merkleRoot: distribution.merkleRoot,
      chainId: distribution.chainId,
      tokenAddress: distribution.tokenAddress,
      distributionAmount: distribution.cumulativeTotal,
      totalAllocated: distribution.cumulativeTotal,
      distributorAddress,
      leaves: distribution.leaves.map((leaf) => ({
        index: leaf.index,
        claimantKey: leaf.claimantKey,
        account: leaf.account,
        amount: leaf.cumulativeAmount,
        leafHash: leaf.leafHash,
        proof: [...leaf.proof],
      })),
      actorLiabilities,
      actorSettlements,
    });

    logger.info(
      {
        epochId: args.epochId.toString(),
        merkleRoot: `${distribution.merkleRoot.slice(0, 12)}...`,
        mintDelta: distribution.mintDelta.toString(),
        cumulativeTotal: distribution.cumulativeTotal.toString(),
        leafCount: distribution.leaves.length,
        unresolvedClaimantKeys,
      },
      "Cumulative distribution built + persisted from finalize signature"
    );

    return {
      distributionId: distribution.distributionId,
      merkleRoot: distribution.merkleRoot,
      mintDelta: distribution.mintDelta.toString(),
      cumulativeTotal: distribution.cumulativeTotal.toString(),
      leafCount: distribution.leaves.length,
      tokenAddress: distribution.tokenAddress,
      chainId: distribution.chainId,
      distributorAddress,
    };
  }

  const epochId = BigInt(input.epochId);

  logger.info(
    { epochId: input.epochId, signerAddress: input.signerAddress },
    "Finalizing epoch"
  );

  // 1. Load epoch — verify exists and is review (or finalized for idempotency)
  const epoch = await attributionStore.getEpoch(epochId);
  if (!epoch) {
    throw new FinalizeEpochError(
      "epoch_not_found",
      `finalizeEpoch: epoch ${input.epochId} not found`
    );
  }

  // EPOCH_FINALIZE_IDEMPOTENT: already finalized → repair via atomic method
  if (epoch.status === "finalized") {
    logger.info(
      { epochId: input.epochId },
      "Epoch already finalized — repairing via finalizeEpochAtomic"
    );
    const existing = await attributionStore.getStatementForEpoch(epochId);
    if (!existing) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} is finalized but no statement found`
      );
    }

    // Repair: ensure this signer's signature exists via atomic method
    await attributionStore.finalizeEpochAtomic({
      epochId,
      poolTotal: existing.poolTotalCredits,
      finalClaimantAllocations: await attributionStore
        .getFinalClaimantAllocationsForEpoch(epochId)
        .then((allocations) =>
          allocations.map((allocation) => ({
            nodeId: allocation.nodeId,
            epochId: allocation.epochId,
            claimantKey: allocation.claimantKey,
            claimant: allocation.claimant,
            finalUnits: allocation.finalUnits,
            receiptIds: allocation.receiptIds,
          }))
        ),
      statement: {
        nodeId,
        finalAllocationSetHash: existing.finalAllocationSetHash,
        poolTotalCredits: existing.poolTotalCredits,
        statementLines: existing.statementLines,
      },
      signature: {
        nodeId,
        signerWallet: input.signerAddress,
        signature: input.signature,
        signedAt: new Date(),
      },
      expectedFinalAllocationSetHash: existing.finalAllocationSetHash,
    });

    // R3: re-build the cumulative manifest on repair too — heals a missing or
    // stale cumulative root from an earlier finalize that predated this path.
    let repairCumulative: FinalizeEpochOutput["cumulativeDistribution"] = null;
    try {
      repairCumulative = await buildAndPersistCumulativeDistribution({
        epochId,
        statementId: existing.id,
        finalAllocationSetHash: existing.finalAllocationSetHash,
        statementLines: existing.statementLines.map((line) => ({
          claimant_key: line.claimant_key,
          credit_amount: line.credit_amount,
          receipt_ids: [...line.receipt_ids],
        })),
      });
    } catch (err) {
      logger.error(
        {
          epochId: input.epochId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Cumulative distribution repair failed — epoch stays finalized"
      );
    }

    return {
      statementId: existing.id,
      poolTotalCredits: existing.poolTotalCredits.toString(),
      finalAllocationSetHash: existing.finalAllocationSetHash,
      statementLineCount: existing.statementLines.length,
      cumulativeDistribution: repairCumulative,
    };
  }

  if (epoch.status !== "review") {
    throw new FinalizeEpochError(
      "epoch_not_in_review",
      `finalizeEpoch: epoch ${input.epochId} is '${epoch.status}', expected 'review'`
    );
  }

  // 2. CONFIG_LOCKED_AT_REVIEW: verify config is locked
  if (!epoch.allocationAlgoRef || !epoch.weightConfigHash) {
    throw new FinalizeEpochError(
      "config_not_locked",
      `finalizeEpoch: epoch ${input.epochId} missing allocation_algo_ref or weight_config_hash (CONFIG_LOCKED_AT_REVIEW violated)`
    );
  }

  // 3. Verify signer is in pinned approvers (APPROVERS_PINNED_AT_REVIEW)
  if (!epoch.approvers || epoch.approvers.length === 0) {
    throw new FinalizeEpochError(
      "no_approvers",
      `finalizeEpoch: epoch ${input.epochId} has no pinned approvers (APPROVERS_PINNED_AT_REVIEW violated)`
    );
  }
  const signerLower = input.signerAddress.toLowerCase();
  const approversLower = epoch.approvers.map((a) => a.toLowerCase());
  if (!approversLower.includes(signerLower)) {
    throw new FinalizeEpochError(
      "signer_not_approver",
      `finalizeEpoch: signer ${input.signerAddress} not in approvers`
    );
  }
  // Self-consistent integrity check: recompute hash from pinned list
  const pinnedApproverSetHash = await computeApproverSetHash(epoch.approvers);
  if (epoch.approverSetHash !== pinnedApproverSetHash) {
    throw new Error(
      `finalizeEpoch: approver set hash integrity failure — stored hash ${epoch.approverSetHash} does not match recomputed ${pinnedApproverSetHash}`
    );
  }

  // 4. Load pool components → pool_total = SUM(amount_credits)
  const poolComponents =
    await attributionStore.getPoolComponentsForEpoch(epochId);
  if (poolComponents.length === 0) {
    throw new FinalizeEpochError(
      "no_pool_components",
      `finalizeEpoch: epoch ${input.epochId} has no pool components (POOL_REQUIRES_BASE)`
    );
  }
  const hasBaseIssuance = poolComponents.some(
    (c) => c.componentId === "base_issuance"
  );
  if (!hasBaseIssuance) {
    throw new FinalizeEpochError(
      "missing_base_issuance",
      `finalizeEpoch: epoch ${input.epochId} missing base_issuance component (POOL_REQUIRES_BASE)`
    );
  }

  const poolTotal = poolComponents.reduce(
    (sum, c) => sum + c.amountCredits,
    0n
  );

  // 5. Load locked claimants + receipt weights + overrides → explode to claimant allocations
  const lockedClaimants = await attributionStore.loadLockedClaimants(epochId);
  if (lockedClaimants.length === 0) {
    throw new FinalizeEpochError(
      "no_locked_claimants",
      `finalizeEpoch: epoch ${input.epochId} has no locked claimant rows`
    );
  }

  const [selections, overrideRecords] = await Promise.all([
    attributionStore.getSelectedReceiptsForAllocation(epochId),
    attributionStore.getReviewSubjectOverridesForEpoch(epochId),
  ]);
  const rawWeights = await dispatchAllocator(
    registries.allocators,
    epoch.allocationAlgoRef,
    {
      receipts: selections,
      weightConfig: epoch.weightConfig,
      evaluations: toEvaluationPayloadMap(
        await attributionStore.getEvaluationsForEpoch(epochId, "locked")
      ),
      profileConfig: null,
    }
  );
  const overrides = toReviewSubjectOverrides(overrideRecords);
  const receiptWeights = applyReceiptWeightOverrides(rawWeights, overrides);

  const finalClaimantAllocations = explodeToClaimants(
    receiptWeights,
    lockedClaimants,
    overrides
  );
  if (finalClaimantAllocations.length === 0) {
    throw new FinalizeEpochError(
      "no_claimant_allocations",
      `finalizeEpoch: epoch ${input.epochId} has no claimant allocations`
    );
  }

  // Build override audit trail for statement persistence
  const reviewOverrideSnapshots = buildReceiptWeightOverrideSnapshots(
    rawWeights,
    lockedClaimants,
    overrides
  );

  // 6. Compute statement lines from final allocations
  const statementLines = computeAttributionStatementLines(
    finalClaimantAllocations,
    poolTotal
  );

  // 7. Compute allocation set hash (deterministic)
  const finalAllocationSetHash = await computeFinalClaimantAllocationSetHash(
    finalClaimantAllocations
  );

  // 8. Build EIP-712 typed data and verify signature
  const typedData = buildEIP712TypedData({
    nodeId,
    scopeId,
    epochId: input.epochId,
    deploymentEnvironment,
    finalAllocationSetHash,
    poolTotalCredits: poolTotal.toString(),
    chainId,
  });

  const isValid = await verifyTypedData({
    address: input.signerAddress as `0x${string}`,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: input.signature as `0x${string}`,
  });
  if (!isValid) {
    throw new FinalizeEpochError(
      "signature_invalid",
      `finalizeEpoch: signature verification failed for signer ${input.signerAddress}`
    );
  }

  // 9. Atomic finalize — epoch transition + statement + signature in one transaction
  const { epoch: finalizedEpoch, statement } =
    await attributionStore.finalizeEpochAtomic({
      epochId,
      poolTotal,
      finalClaimantAllocations: finalClaimantAllocations.map((allocation) => ({
        nodeId,
        epochId,
        claimantKey: claimantKey(allocation.claimant),
        claimant: allocation.claimant,
        finalUnits: allocation.finalUnits,
        receiptIds: [...(allocation.receiptIds ?? [])],
      })),
      statement: {
        nodeId,
        finalAllocationSetHash,
        poolTotalCredits: poolTotal,
        statementLines: statementLines.map((line) => ({
          claimant_key: line.claimantKey,
          claimant: line.claimant,
          final_units: line.finalUnits.toString(),
          pool_share: line.poolShare,
          credit_amount: line.creditAmount.toString(),
          receipt_ids: [...line.receiptIds],
        })),
        reviewOverrides:
          reviewOverrideSnapshots.length > 0 ? reviewOverrideSnapshots : null,
      },
      signature: {
        nodeId,
        signerWallet: input.signerAddress,
        signature: input.signature,
        signedAt: new Date(),
      },
      expectedFinalAllocationSetHash: finalAllocationSetHash,
    });

  logger.info(
    {
      epochId: input.epochId,
      statementId: statement.id,
      poolTotalCredits: poolTotal.toString(),
      finalAllocationSetHash: `${finalAllocationSetHash.slice(0, 12)}...`,
      statementLineCount: statementLines.length,
      status: finalizedEpoch.status,
    },
    "Epoch finalized"
  );

  // R3: the SAME finalize signature drives the cumulative root + mint delta.
  // Built/persisted after the atomic off-chain finalize so a build failure
  // never undoes the signed statement; the off-chain ledger is authoritative.
  let cumulativeDistribution: FinalizeEpochOutput["cumulativeDistribution"] =
    null;
  try {
    cumulativeDistribution = await buildAndPersistCumulativeDistribution({
      epochId,
      statementId: statement.id,
      finalAllocationSetHash,
      statementLines: statementLines.map((line) => ({
        claimant_key: line.claimantKey,
        credit_amount: line.creditAmount.toString(),
        receipt_ids: [...line.receiptIds],
      })),
      actorFoldInputs: {
        receiptWeights,
        lockedClaimants,
        overrides,
      },
    });
  } catch (err) {
    logger.error(
      {
        epochId: input.epochId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Cumulative distribution build failed AFTER finalize — epoch stays finalized; retry/repair on next finalize call"
    );
  }

  return {
    statementId: statement.id,
    poolTotalCredits: poolTotal.toString(),
    finalAllocationSetHash,
    statementLineCount: statementLines.length,
    cumulativeDistribution,
  };
}
