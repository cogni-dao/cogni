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
import { dispatchCanonicalForkSync } from "@/app/_facades/deploy/canonical-fork-sync.server";
import { dispatchNodePreviewPromote } from "@/app/_facades/deploy/node-preview-promote.server";
import { dispatchPrReview } from "@/app/_facades/review/dispatch.server";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { dispatchSignalExecution } from "@/features/governance/services/signal-dispatch";
import {
  receiveWebhook,
  WebhookPayloadParseError,
  WebhookSourceNotFoundError,
  WebhookVerificationError,
} from "@/features/ingestion/services/webhook-receiver";
import { findNodeByRepo } from "@/features/nodes/node-lookup";
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
 * Resolve which node OWNS this webhook's repo, so its receipts land in THAT node's ledger.
 *
 * A webhook payload is exactly one repository, so we resolve ONCE per request. For `github`, parse
 * the body, read `repository.full_name`, split into owner/name, and look up the owning node by repo
 * (case-insensitive; the `nodes_repo_owner_name_lower_unique` index makes it single-valued — anti-theft
 * by construction). When no node is registered for the repo — or for any non-github source — we FALL
 * BACK to the operator node (`getNodeId()`), keeping unregistered repos fail-safe in the operator
 * ledger (the prior behavior). Returns the resolved id plus enough context for observability.
 */
export async function resolveTargetNode(
  source: string,
  body: Buffer
): Promise<{
  readonly nodeId: string;
  readonly repo: string | null;
  readonly fallbackToOperator: boolean;
}> {
  const operatorNodeId = getNodeId();

  if (source !== "github") {
    return { nodeId: operatorNodeId, repo: null, fallbackToOperator: true };
  }

  let repo: string | null = null;
  try {
    const payload = JSON.parse(body.toString("utf-8")) as {
      repository?: { full_name?: string };
    };
    // Read the routing key straight off the verified-by-secret webhook payload (the route already
    // parses the body for its dispatches). Avoids importing the ingestion adapter into the app layer
    // (no-restricted-imports); the adapter still owns normalization for the receipt itself.
    repo = payload.repository?.full_name ?? null;
  } catch {
    // Malformed body: receiveWebhook re-parses and raises WebhookPayloadParseError.
    // Stay fail-safe on the operator ledger here.
    return { nodeId: operatorNodeId, repo: null, fallbackToOperator: true };
  }

  const slash = repo?.indexOf("/") ?? -1;
  if (!repo || slash <= 0) {
    return { nodeId: operatorNodeId, repo, fallbackToOperator: true };
  }

  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const owning = await findNodeByRepo(resolveServiceDb(), owner, name);

  return owning
    ? { nodeId: owning.nodeId, repo, fallbackToOperator: false }
    : { nodeId: operatorNodeId, repo, fallbackToOperator: true };
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

    // Route the receipt to the node that OWNS the repo (anti-theft via the unique repo→node map),
    // falling back to the operator node for unregistered repos / non-github sources. Resolved ONCE —
    // a webhook payload is one repository.
    const target = await resolveTargetNode(source, bodyBuffer);

    const result = await receiveWebhook(
      {
        attributionStore: container.attributionStore,
        sourceRegistrations: container.webhookRegistrations,
        nodeId: target.nodeId,
      },
      { source, headers, body: bodyBuffer, secret }
    );

    log.info(
      { source, eventType, eventCount: result.eventCount },
      "webhook processed"
    );

    // Ingestion telemetry: makes attribution receipts observable in Loki. Without
    // this, "are git contributions reaching the ledger?" was unanswerable from logs
    // (only the raw normalized count was logged, never which contributors/event types
    // were persisted). Idempotent — ON CONFLICT DO NOTHING may no-op on replay.
    if (result.receipts.length > 0) {
      log.info(
        {
          event: "attribution.receipt_ingested",
          source,
          // Multi-node ingestion routing proof (story.5023): which node OWNS these receipts, the repo
          // they came from, and whether we fell back to the operator ledger. On candidate-a, Loki must
          // show a non-operator nodeId here for a PR merged to a non-operator node's repo.
          nodeId: target.nodeId,
          repo: target.repo,
          fallbackToOperator: target.fallbackToOperator,
          receiptCount: result.receipts.length,
          eventTypes: [...new Set(result.receipts.map((r) => r.eventType))],
          logins: [
            ...new Set(
              result.receipts
                .map((r) => r.platformLogin)
                .filter((l): l is string => l !== null)
            ),
          ],
          receiptIds: result.receipts.map((r) => r.receiptId),
        },
        "attribution receipts ingested"
      );
    }

    // 5. Fire-and-forget dispatches after successful verification.
    // Runs async — errors logged, never block webhook response.
    if (source === "github" && eventType === "pull_request") {
      const payload = JSON.parse(bodyBuffer.toString("utf-8"));
      dispatchPrReview(payload, env, log);
      // Node-merge → preview tie: a merged spawned-node PR dispatches promote-and-deploy
      // at env=preview SOURCE-ADDRESSED by the PR head sha, pin on deploy/preview, ZERO
      // writes to main (PREVIEW_VIA_SOURCE_ADDRESSED_PROMOTE, task.5022).
      dispatchNodePreviewPromote(payload, env, log);
    }

    // node-template merge→main → mirror canonical content to every child fork (one PR each).
    if (source === "github" && eventType === "push") {
      const payload = JSON.parse(bodyBuffer.toString("utf-8"));
      dispatchCanonicalForkSync(payload, env, log);
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
      dispatchNodePreviewPromote(payload, env, log);
    }

    if (source === "github" && eventType === "push") {
      const payload = JSON.parse(bodyBuffer.toString("utf-8"));
      dispatchCanonicalForkSync(payload, env, log);
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
