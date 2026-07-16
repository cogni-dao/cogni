// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/attribution/receipts`
 * Purpose: Internal endpoint the operator gateway delivers normalized git/activity receipts to;
 *   the owning node persists them in its OWN attribution ledger.
 * Scope: Auth-protected POST — the operator's GitHub App observes git for all node repos, resolves
 *   repo -> owning node_id, normalizes the webhook to receipts, and DELIVERS them here. This is the
 *   node's only inbound write path for foreign-produced receipts. Mirrors graph-runs.create.internal.v1.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - NODE_WRITES_OWN_LEDGER: envelope `nodeId` MUST equal this node's own node_id; the node stamps
 *     its own node_id on each receipt. A node never persists a foreign ledger.
 *   - RECEIPT_IDEMPOTENT: persistence is ON CONFLICT DO NOTHING keyed by (node_id, receipt_id);
 *     repeat delivery (Temporal-style retry / Idempotency-Key) is a no-op.
 * Side-effects: IO (writes ingestion_receipts via AttributionStore)
 * Links: attribution.receipts.internal.v1.contract, task.0280, story.5023
 * @internal
 */

import type { InsertReceiptParams } from "@cogni/attribution-ledger";
import {
  type InternalDeliverReceiptsInput,
  internalDeliverReceiptsOperation,
} from "@cogni/node-contracts";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "attribution.receipts.internal", auth: { mode: "none" } },
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

    const parsed = internalDeliverReceiptsOperation.input.safeParse(body);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.issues }, "Invalid request body");
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const data: InternalDeliverReceiptsInput = parsed.data;
    const nodeId = getNodeId();

    // NODE_WRITES_OWN_LEDGER: refuse to persist a foreign node's ledger.
    if (data.nodeId !== nodeId) {
      log.warn(
        { envelopeNodeId: data.nodeId, nodeId },
        "Rejected foreign node ledger delivery"
      );
      return NextResponse.json(
        { error: "foreign node ledger" },
        { status: 403 }
      );
    }

    // Idempotency-Key is honored at the DB level (ON CONFLICT DO NOTHING); we
    // only surface it in the structured log for delivery tracing.
    const idempotencyKey = request.headers.get("idempotency-key");

    const mapped: InsertReceiptParams[] = data.receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      nodeId,
      source: receipt.source,
      eventType: receipt.eventType,
      platformUserId: receipt.platformUserId,
      // wire fields are nullish (null | undefined); InsertReceiptParams is string | null
      // under exactOptionalPropertyTypes — coerce undefined -> null.
      platformLogin: receipt.platformLogin ?? null,
      artifactUrl: receipt.artifactUrl ?? null,
      metadata: receipt.metadata ?? null,
      payloadHash: receipt.payloadHash,
      producer: receipt.producer,
      producerVersion: receipt.producerVersion,
      eventTime: new Date(receipt.eventTime),
      retrievedAt: new Date(receipt.retrievedAt),
    }));

    await getContainer().attributionStore.insertIngestionReceipts(mapped);

    log.info(
      {
        event: "attribution.receipts_ingested",
        nodeId,
        source: data.source,
        count: mapped.length,
        idempotencyKey,
      },
      "Ingested attribution receipts"
    );

    return NextResponse.json(
      { ok: true, nodeId, received: mapped.length },
      { status: 200 }
    );
  }
);
