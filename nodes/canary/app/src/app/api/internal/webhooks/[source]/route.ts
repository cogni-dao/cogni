// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/webhooks/[source]`
 * Purpose: Webhook receiver route — accepts platform webhook payloads and inserts receipts.
 * Scope: HTTP entry point only. Delegates to WebhookReceiverService. Does not contain business logic.
 * Invariants:
 * - WEBHOOK_VERIFY_BEFORE_NORMALIZE: Verification happens inside the feature service before normalization
 * - WEBHOOK_RECEIPT_APPEND_EXEMPT: Receipt insertion bypasses WRITES_VIA_TEMPORAL (safe per RECEIPT_IDEMPOTENT + RECEIPT_APPEND_ONLY)
 * - ARCHITECTURE_ALIGNMENT: Route → feature service → port
 * Side-effects: IO (database writes via feature service)
 * Links: docs/spec/attribution-ledger.md
 * @internal
 */

import { NextResponse } from "next/server";
import { dispatchPrReview } from "@/app/_facades/review/dispatch.server";
import { getContainer } from "@/bootstrap/container";
import { dispatchSignalExecution } from "@/features/governance/services/signal-dispatch";
import {
  receiveWebhook,
  WebhookPayloadParseError,
  WebhookSourceNotFoundError,
  WebhookVerificationError,
} from "@/features/ingestion/services/webhook-receiver";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { makeLogger } from "@/shared/observability";

const log = makeLogger().child({ component: "webhook-route" });

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Max body size for webhook payloads (1MB) */
const MAX_BODY_SIZE = 1_048_576;

/**
 * Resolve webhook secret for a given source.
 * V0: environment variable per source. P1: connections table.
 */
function resolveWebhookSecret(
  source: string,
  env: ReturnType<typeof serverEnv>
): string | null {
  switch (source) {
    case "github":
      return env.GH_WEBHOOK_SECRET ?? null;
    case "alchemy":
      return env.ALCHEMY_WEBHOOK_SECRET ?? null;
    default:
      return null;
  }
}

interface RouteParams {
  params: Promise<{ source: string }>;
}

/**
 * POST /api/internal/webhooks/{source}
 *
 * Receives webhook payloads from external platforms (GitHub, Discord, etc.).
 * Auth: Platform-specific signature verification (e.g., X-Hub-Signature-256).
 * No session auth — this endpoint is called by external platforms.
 */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { source } = await params;
  const env = serverEnv();

  // 1. Resolve webhook secret
  const secret = resolveWebhookSecret(source, env);
  if (!secret) {
    return NextResponse.json(
      { error: `Webhook not configured for source: ${source}` },
      { status: 404 }
    );
  }

  // 2. Fast-path reject oversized payloads before reading body into memory
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Read raw body (needed for signature verification)
  const bodyBuffer = Buffer.from(await request.arrayBuffer());
  if (bodyBuffer.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // 3. Extract headers as plain object
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const eventType = headers["x-github-event"] ?? "unknown";

  // 4. Delegate ingestion to feature service (verify → normalize → insert receipts)
  try {
    const container = getContainer();

    const result = await receiveWebhook(
      {
        attributionStore: container.attributionStore,
        sourceRegistrations: container.webhookRegistrations,
        nodeId: getNodeId(),
      },
      { source, headers, body: bodyBuffer, secret }
    );

    log.info(
      { source, eventType, eventCount: result.eventCount },
      "webhook processed"
    );

    // 5. Fire-and-forget dispatches after successful verification.
    // Runs async — errors logged, never block webhook response.
    if (source === "github" && eventType === "pull_request") {
      const payload = JSON.parse(bodyBuffer.toString("utf-8"));
      dispatchPrReview(payload, env, log);
    }

    if (source === "alchemy") {
      const payload = JSON.parse(bodyBuffer.toString("utf-8"));
      dispatchSignalExecution(payload, env, log);
    }

    return NextResponse.json(
      { ok: true, eventCount: result.eventCount },
      { status: 200 }
    );
  } catch (error) {
    // Verification / parse errors → reject
    if (error instanceof WebhookSourceNotFoundError) {
      log.warn({ source }, "webhook source not found");
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof WebhookVerificationError) {
      log.warn({ source }, "webhook verification failed");
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof WebhookPayloadParseError) {
      log.warn({ source }, "webhook payload parse error");
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // DB or other infra error — still dispatch review (signature was already verified
    // inside receiveWebhook before the DB insert that failed).
    log.error(
      { source, eventType, error: String(error) },
      "webhook ingestion failed — dispatching review anyway"
    );

    if (source === "github" && eventType === "pull_request") {
      const payload = JSON.parse(bodyBuffer.toString("utf-8"));
      dispatchPrReview(payload, env, log);
    }

    if (source === "alchemy") {
      const payload = JSON.parse(bodyBuffer.toString("utf-8"));
      dispatchSignalExecution(payload, env, log);
    }

    return NextResponse.json(
      { ok: false, error: "Ingestion failed" },
      { status: 500 }
    );
  }
}
