// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/contributors/route`
 * Purpose: Agent-first authenticated read serving an epoch's selection-to-contributor rollup (any status, no finalized gate) plus the active attribution policy and window.
 * Scope: SIWE-or-bearer-protected GET route reusing the epoch-activity store reads and composeEpochView aggregation. Does not duplicate aggregation logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, ACTIVITY_AUTHED, SELECTION_IS_THE_GATE.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.epoch-contributors.v1.contract
 * @public
 */

import { epochContributorsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import {
  toIngestionReceiptDto,
  toSelectionDto,
} from "@/app/api/v1/public/attribution/_lib/attribution-dto";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { composeEpochView } from "@/features/governance/lib/compose-epoch";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Active attribution policy/profile id. SSOT is repo-spec `attribution_pipeline`;
 * V0 is the same constant the review route pins via deriveAllocationAlgoRef.
 * TODO: source from the epoch's activity-source config once exposed app-side.
 */
const ACTIVE_ATTRIBUTION_PIPELINE = "cogni-v0.0";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.epoch-contributors",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const store = getContainer().attributionStore;
    const nodeId = getNodeId();

    // Load epoch — any status, no finalized gate.
    const epoch = await store.getEpoch(epochId);
    if (!epoch) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    // Same store reads as the epoch-activity route: window receipts (may be
    // pending) + epoch-selected receipts (may be cross-epoch), deduped.
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

    // Read-time identity resolution: resolve unresolved GitHub identities so
    // linked users aggregate immediately (mirrors the activity route).
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

    const enriched = receipts.map((r) => {
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

    return NextResponse.json(
      epochContributorsOperation.output.parse({
        epochId: epoch.id.toString(),
        status: epoch.status,
        periodStart: epoch.periodStart.toISOString(),
        periodEnd: epoch.periodEnd.toISOString(),
        attributionPipeline: ACTIVE_ATTRIBUTION_PIPELINE,
        contributors,
        totalPoints,
      })
    );
  }
);
