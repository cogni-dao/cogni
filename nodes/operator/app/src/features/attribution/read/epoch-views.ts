// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/attribution/read/epoch-views`
 * Purpose: Node-id-parameterized read logic for attribution epochs — list, contributors
 *   rollup, and activity union. The ONE place the aggregation + identity-resolution flow
 *   lives so the operator-self routes (`/api/v1/attribution/epochs/*`, nodeId = `getNodeId()`)
 *   and the node-addressable routes (`/api/v1/nodes/[id]/attribution/epochs/*`, nodeId =
 *   `resolveNodeRef(...)`) cannot drift on what an epoch view contains.
 * Scope: Pure-ish service functions over the injected `AttributionStore` — they take a
 *   `nodeId` and an `epochId`, do the same window+selected receipt reads, dedup, read-time
 *   identity resolution, and `composeEpochView` aggregation the routes used to inline.
 *   Does NOT own auth, HTTP shaping, or node resolution — the routes keep those.
 * Invariants: NODE_SCOPED (every store read is scoped by the passed nodeId), ALL_MATH_BIGINT,
 *   SELECTION_IS_THE_GATE (any status, no finalized gate), AGGREGATION_VIA_COMPOSE_EPOCH
 *   (no reimplementation — reuse `composeEpochView`).
 * Side-effects: IO (database read; activity view fires background selection userId updates).
 * Links: src/features/governance/lib/compose-epoch.ts,
 *   src/app/api/v1/attribution/epochs/**, src/app/api/v1/nodes/[id]/attribution/epochs/**
 * @public
 */

import type { AttributionStore } from "@cogni/attribution-ledger";
import {
  toEpochDto,
  toIngestionReceiptDto,
  toSelectionDto,
} from "@/features/attribution/read/attribution-dto";
import { composeEpochView } from "@/features/governance/lib/compose-epoch";

/**
 * Active attribution policy/profile id. SSOT is repo-spec `attribution_pipeline`;
 * V0 is the same constant the review route pins via deriveAllocationAlgoRef.
 * TODO: source from the epoch's activity-source config once exposed app-side.
 */
export const ACTIVE_ATTRIBUTION_PIPELINE = "cogni-v0.0";

/** Marker the route maps to a 404 when the epoch does not exist. */
export const EPOCH_NOT_FOUND = Symbol("epoch-not-found");

/**
 * List all epochs (including open) for `nodeId`, returning a page of DTOs plus the unpaginated
 * total. Mirrors the operator-self list route — only the nodeId is parameterized.
 */
export async function listEpochsForNode(
  store: AttributionStore,
  nodeId: string,
  page: { limit: number; offset: number }
): Promise<{ epochs: ReturnType<typeof toEpochDto>[]; total: number }> {
  const allEpochs = await store.listEpochs(nodeId);
  const slice = allEpochs.slice(page.offset, page.offset + page.limit);
  return { epochs: slice.map(toEpochDto), total: allEpochs.length };
}

/**
 * Load the window + epoch-selected receipts for `nodeId`/`epochId`, dedup by receiptId, join
 * selections, and run read-time GitHub identity resolution. Shared by both the contributors
 * and activity views. `onResolved` lets the activity caller persist resolved userIds + log;
 * the contributors caller omits it (read-only resolution).
 */
async function loadEnrichedReceipts(
  store: AttributionStore,
  nodeId: string,
  epoch: NonNullable<Awaited<ReturnType<AttributionStore["getEpoch"]>>>,
  epochId: bigint,
  onResolved?: (resolved: Map<string, string>, unresolvedCount: number) => void
) {
  // Same store reads as the epoch-activity route: window receipts (may be pending) +
  // epoch-selected receipts (may be cross-epoch), deduped.
  const [windowReceipts, epochSelectedReceipts] = await Promise.all([
    store.getReceiptsForWindow(nodeId, epoch.periodStart, epoch.periodEnd),
    store.getReceiptsForEpoch(nodeId, epochId),
  ]);

  const seen = new Set<string>();
  const receipts: typeof windowReceipts = [];
  for (const r of windowReceipts) {
    seen.add(r.receiptId);
    receipts.push(r);
  }
  for (const r of epochSelectedReceipts) {
    if (!seen.has(r.receiptId)) {
      receipts.push(r);
    }
  }

  const selections = await store.getSelectionForEpoch(epochId);
  const selectionMap = new Map(selections.map((s) => [s.receiptId, s]));

  // Read-time identity resolution: resolve unresolved GitHub identities so linked users
  // aggregate immediately without waiting for the next scheduler run.
  const unresolvedGithubIds = new Set<string>();
  for (const r of receipts) {
    const sel = selectionMap.get(r.receiptId);
    if ((!sel || sel.userId === null) && r.source === "github") {
      unresolvedGithubIds.add(r.platformUserId);
    }
  }
  const resolvedIdentities =
    unresolvedGithubIds.size > 0
      ? await store.resolveIdentities("github", [...unresolvedGithubIds])
      : new Map<string, string>();

  if (resolvedIdentities.size > 0) {
    onResolved?.(
      resolvedIdentities,
      unresolvedGithubIds.size - resolvedIdentities.size
    );
  }

  const enriched: EnrichedReceipt[] = receipts.map((r) => {
    const selection = selectionMap.get(r.receiptId);
    const needsResolution =
      r.source === "github" && (!selection || selection.userId === null);
    const resolvedUserId = needsResolution
      ? (resolvedIdentities.get(r.platformUserId) ?? null)
      : null;
    const selectionDto = selection
      ? toSelectionDto({
          ...selection,
          userId: resolvedUserId ?? selection.userId,
        })
      : null;
    return {
      ...toIngestionReceiptDto(r),
      selection: selectionDto,
    };
  });

  return { enriched, receipts, selectionMap, resolvedIdentities };
}

/** One activity-view event: an ingestion-receipt DTO with its (possibly null) selection DTO. */
export type EnrichedReceipt = ReturnType<typeof toIngestionReceiptDto> & {
  selection: ReturnType<typeof toSelectionDto> | null;
};

/** Contributors-view payload, matching `epochContributorsOperation.output`. */
export interface EpochContributorsView {
  epochId: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  attributionPipeline: string;
  contributors: {
    claimantKey: string;
    // Mirrors `composeEpochView` output (and the pre-refactor inline route shape) exactly:
    // identity/user union, nullable displayName, numeric creditShare — do NOT widen to string,
    // that diverges the wire payload from the operator-self route this helper now backs.
    claimantKind: "user" | "identity";
    isLinked: boolean;
    displayName: string | null;
    claimantLabel: string;
    points: string;
    share: number;
    receiptCount: number;
  }[];
  totalPoints: string;
}

/**
 * Build the selection-to-contributor rollup for `nodeId`/`epochId` — any status, no finalized
 * gate — aggregated via `composeEpochView`. Returns `EPOCH_NOT_FOUND` when the epoch is missing.
 */
export async function buildEpochContributorsView(
  store: AttributionStore,
  nodeId: string,
  epochId: bigint
): Promise<EpochContributorsView | typeof EPOCH_NOT_FOUND> {
  const epoch = await store.getEpoch(epochId);
  if (!epoch) return EPOCH_NOT_FOUND;

  const { enriched } = await loadEnrichedReceipts(
    store,
    nodeId,
    epoch,
    epochId
  );

  // Aggregate via the SAME helper the UI uses — no reimplementation.
  const view = composeEpochView(
    {
      id: epoch.id.toString(),
      status: epoch.status,
      periodStart: epoch.periodStart.toISOString(),
      periodEnd: epoch.periodEnd.toISOString(),
      weightConfig: epoch.weightConfig,
      poolTotalCredits: epoch.poolTotalCredits?.toString() ?? null,
    },
    enriched
  );

  const contributors = view.contributors.map((c) => ({
    claimantKey: c.claimantKey,
    claimantKind: c.claimantKind,
    isLinked: c.isLinked,
    displayName: c.displayName,
    claimantLabel: c.claimantLabel,
    points: c.units,
    share: c.creditShare,
    receiptCount: c.receiptCount,
  }));

  const totalPoints = contributors
    .reduce((sum, c) => sum + BigInt(c.points), 0n)
    .toString();

  return {
    epochId: epoch.id.toString(),
    status: epoch.status,
    periodStart: epoch.periodStart.toISOString(),
    periodEnd: epoch.periodEnd.toISOString(),
    attributionPipeline: ACTIVE_ATTRIBUTION_PIPELINE,
    contributors,
    totalPoints,
  };
}

/** Activity-view payload, matching `epochActivityOperation.output`. */
export interface EpochActivityView {
  events: EnrichedReceipt[];
  epochId: string;
  total: number;
}

/**
 * Build the activity union (window ∪ epoch-selected receipts, with selection join) for
 * `nodeId`/`epochId`, paginated. Returns `EPOCH_NOT_FOUND` when the epoch is missing.
 *
 * `onIdentityResolved` is invoked (fire-and-forget at the call site) when GitHub identities
 * were resolved at read time, so the caller can persist them + emit its observability event.
 * Persistence uses `updateSelectionUserId(epochId, receiptId, userId)`; only rows whose
 * selection currently has a null userId are updated.
 */
export async function buildEpochActivityView(
  store: AttributionStore,
  nodeId: string,
  epochId: bigint,
  /** The raw `[id]` path segment — echoed back in `epochId` to preserve route behavior. */
  epochIdRaw: string,
  page: { limit: number; offset: number },
  onIdentityResolved?: (info: {
    resolvedCount: number;
    unresolvedCount: number;
  }) => void
): Promise<EpochActivityView | typeof EPOCH_NOT_FOUND> {
  const epoch = await store.getEpoch(epochId);
  if (!epoch) return EPOCH_NOT_FOUND;

  const { enriched, receipts, selectionMap } = await loadEnrichedReceipts(
    store,
    nodeId,
    epoch,
    epochId,
    (resolvedIdentities, unresolvedCount) => {
      // Fire-and-forget: persist resolved userIds to selection rows for future reads.
      const updates: Promise<void>[] = [];
      for (const r of receipts) {
        const sel = selectionMap.get(r.receiptId);
        if (sel && sel.userId === null && r.source === "github") {
          const resolved = resolvedIdentities.get(r.platformUserId);
          if (resolved) {
            updates.push(
              store.updateSelectionUserId(epochId, r.receiptId, resolved)
            );
          }
        }
      }
      // Don't await — background DB updates, response returns immediately.
      void Promise.allSettled(updates);

      onIdentityResolved?.({
        resolvedCount: resolvedIdentities.size,
        unresolvedCount,
      });
    }
  );

  const slice = enriched.slice(page.offset, page.offset + page.limit);

  return {
    events: slice,
    epochId: epochIdRaw,
    total: enriched.length,
  };
}
