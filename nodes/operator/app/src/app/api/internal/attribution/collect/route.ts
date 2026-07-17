// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/attribution/collect`
 * Purpose: Internal endpoint that runs one attribution collect pass IN-PROCESS against this
 *   node's OWN ledger DB — the collect dispatch-hop, mirroring how graph runs dispatch via
 *   /api/internal/graph-runs. Composes runCollectPass over the receipts already delivered to
 *   this node.
 * Scope: Auth-protected POST that ensures/transitions the epoch, selects/enriches/allocates over
 *   this node's OWN receipts, and ensures pool components. Does not change the operator's Temporal
 *   collect path (CollectEpochWorkflow on ledger-worker is unchanged); does not poll webhook-only
 *   sources (their receipts already arrived via the Phase-1 receipt seam).
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - NODE_WRITES_OWN_LEDGER: envelope `nodeId` MUST equal this node's own node_id; a node never
 *     runs collect for a foreign ledger.
 *   - WEBHOOK_ONLY_SKIPS_POLL: a spawned node has webhook-only registrations; collect skips polling
 *     and runs selection/enrichment/allocation over delivered receipts.
 * Side-effects: IO (reads/writes this node's attribution ledger via AttributionStore)
 * Links: docs/design/attribution-operator-gateway.md, attribution.receipts.internal.v1.contract, story.5023
 * @internal
 */

import {
  type AttributionIngestRunV1,
  runCollectPass,
} from "@cogni/attribution-collect";
import { createValidatedAttributionStore } from "@cogni/attribution-ledger";
import { CHAIN_ID, verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  getLedgerApprovers,
  getLedgerConfig,
  getNodeId,
  getScopeId,
} from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const collectRequestSchema = z.object({
  nodeId: z.string().min(1),
  asOfIso: z.string().datetime().optional(),
});

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "attribution.collect.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    const log = ctx.log;

    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        env.SCHEDULER_API_TOKEN
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = collectRequestSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.issues }, "Invalid request body");
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const nodeId = getNodeId();

    // NODE_WRITES_OWN_LEDGER: refuse to run collect for a foreign node's ledger.
    if (parsed.data.nodeId !== nodeId) {
      log.warn(
        { envelopeNodeId: parsed.data.nodeId, nodeId },
        "Rejected foreign node ledger collect"
      );
      return NextResponse.json(
        { error: "foreign node ledger" },
        { status: 403 }
      );
    }

    const ledgerConfig = getLedgerConfig();
    if (!ledgerConfig) {
      log.warn({ nodeId }, "No activity_ledger config — collect unavailable");
      return NextResponse.json(
        { error: "ledger config not present" },
        { status: 400 }
      );
    }

    const scopeId = getScopeId();

    // Build the versioned collect envelope from repo-spec (same fields the
    // scheduler-worker feeds CollectEpochWorkflow).
    const config: AttributionIngestRunV1 = {
      version: 1,
      scopeId,
      scopeKey: ledgerConfig.scopeKey,
      epochLengthDays: ledgerConfig.epochLengthDays,
      activitySources: Object.fromEntries(
        Object.entries(ledgerConfig.activitySources).map(([source, s]) => [
          source,
          {
            attributionPipeline: s.attributionPipeline,
            sourceRefs: s.sourceRefs,
          },
        ])
      ),
      ...(ledgerConfig.baseIssuanceCredits !== undefined && {
        baseIssuanceCredits: ledgerConfig.baseIssuanceCredits,
      }),
      approvers: getLedgerApprovers(),
    };

    const container = getContainer();

    try {
      const summary = await runCollectPass(
        {
          // Collect uses the validated store wrapper (the receipts route uses the
          // raw adapter for pure persistence).
          attributionStore: createValidatedAttributionStore(
            container.attributionStore
          ),
          sourceRegistrations: container.sourceRegistrations,
          registries: container.registries,
          nodeId,
          scopeId,
          chainId: CHAIN_ID,
          logger: log,
        },
        config,
        parsed.data.asOfIso ?? new Date().toISOString()
      );

      log.info(
        {
          event: "attribution.collect_pass_complete",
          nodeId,
          epochId: summary.epochId,
          epochStatus: summary.epochStatus,
          sourcesPolled: summary.sourcesPolled,
          receiptsInserted: summary.receiptsInserted,
        },
        "Attribution collect pass complete"
      );

      return NextResponse.json({ ok: true, ...summary }, { status: 200 });
    } catch (err) {
      log.error(
        { err, nodeId, event: "attribution.collect_pass_error" },
        "Attribution collect pass failed"
      );
      return NextResponse.json(
        { error: "collect pass failed" },
        { status: 500 }
      );
    }
  }
);
