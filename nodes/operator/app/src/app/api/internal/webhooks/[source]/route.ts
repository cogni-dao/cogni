// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/webhooks/[source]`
 * Purpose: Webhook receiver route — accepts platform payloads and uniquely routes attribution receipts.
 * Scope: HTTP entry point only. Delegates to WebhookReceiverService. Does not contain business logic.
 * Invariants:
 * - WEBHOOK_VERIFY_BEFORE_ROUTE: Verification happens before parsing, routing, persistence, or dispatch
 * - WEBHOOK_RECEIPT_APPEND_EXEMPT: Receipt insertion bypasses WRITES_VIA_TEMPORAL (safe per RECEIPT_IDEMPOTENT + RECEIPT_APPEND_ONLY)
 * - UNIQUE_ROUTE_OR_NO_WRITE: GitHub attribution never falls back to the operator ledger.
 * - FRESH_NODE_FORCE_REFRESH: verified unresolved GitHub routes bypass the cache exactly once.
 * - ARCHITECTURE_ALIGNMENT: Route → feature service → port
 * Side-effects: IO (database writes via feature service)
 * Links: docs/spec/attribution-ledger.md
 * @internal
 */

import { NextResponse } from "next/server";
import { dispatchCanonicalForkSync } from "@/app/_facades/deploy/canonical-fork-sync.server";
import { dispatchLaneOnboard } from "@/app/_facades/deploy/lane-onboard.server";
import { dispatchNodePreviewPromote } from "@/app/_facades/deploy/node-preview-promote.server";
import { dispatchPrReview } from "@/app/_facades/review/dispatch.server";
import {
  getContainer,
  resolveAttributionProfileResolver,
} from "@/bootstrap/container";
import { dispatchSignalExecution } from "@/features/governance/services/signal-dispatch";
import {
  receiveVerifiedWebhook,
  verifyWebhook,
  WebhookPayloadParseError,
  WebhookSourceNotFoundError,
  WebhookVerificationError,
} from "@/features/ingestion/services/webhook-receiver";
import type { RepoRouteDecision } from "@/features/nodes/attribution-profile-resolver";
import type { ReceiptDeliveryTarget } from "@/ports";
import { getNodeId, getNodeName } from "@/shared/config";
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
 * The node that OWNS this webhook's receipts.
 *
 * ATTRIBUTION_ROUTE_BY_SOURCE_REFS: for GitHub, read `repository.full_name` off the parsed body and
 * ask the attribution-profile resolver which sovereign node declared that `owner/repo` in its
 * `activity_ledger.activity_sources.github.source_refs`. GitHub attribution requires one unique
 * match; every other decision carries a null target so no ledger is polluted. Non-GitHub sources
 * retain the operator-local path. Signature verification remains inside `receiveWebhook` before
 * normalization or persistence.
 */
async function resolveTargetNode(
  source: string,
  payload: Record<string, unknown>,
  options?: { readonly forceRefresh?: boolean }
): Promise<{
  target: ReceiptDeliveryTarget | null;
  repo: string | null;
  status: RepoRouteDecision["status"] | "operator_local" | "missing_repo";
  detail?: RepoRouteDecision | undefined;
}> {
  if (source !== "github") {
    return {
      target: { nodeId: getNodeId(), slug: getNodeName() },
      repo: null,
      status: "operator_local",
    };
  }

  const repository = payload.repository;
  const fullName =
    typeof repository === "object" &&
    repository !== null &&
    "full_name" in repository &&
    typeof repository.full_name === "string"
      ? repository.full_name
      : null;
  if (!fullName) {
    return { target: null, repo: null, status: "missing_repo" };
  }

  const decision = await resolveAttributionProfileResolver().resolveRepoRoute(
    fullName,
    options
  );
  if (decision.status === "matched") {
    return {
      target: {
        nodeId: decision.target.id,
        slug: decision.target.slug,
      },
      repo: decision.repo,
      status: decision.status,
      detail: decision,
    };
  }
  return {
    target: null,
    repo: decision.repo,
    status: decision.status,
    detail: decision,
  };
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
  // Non-null only after verifyWebhook returns; the catch path uses this as its positive proof.
  let verifiedPayload: Record<string, unknown> | null = null;

  // 4. Delegate ingestion to feature service (verify → normalize → insert receipts)
  try {
    const container = getContainer();

    // Positive verification is the boundary for every parse, App lookup, ledger write, and hook.
    const verified = await verifyWebhook(container.webhookRegistrations, {
      source,
      headers,
      body: bodyBuffer,
      secret,
    });
    verifiedPayload = verified.payload;

    // GitHub receipts require a unique catalog+profile owner. An unresolved route still verifies
    // and normalizes so unrelated review/sync hooks can run, but it writes no attribution receipt.
    let target = await resolveTargetNode(source, verified.payload);
    if (
      source === "github" &&
      (target.status === "unclaimed" ||
        target.status === "index_unavailable" ||
        target.status === "profile_unavailable")
    ) {
      // GitHub does not automatically redeliver failed webhook deliveries. A fresh node can be
      // absent from a still-valid 10s snapshot, so bypass it exactly once while this verified
      // request is in hand. The refresh remains single-flight; a second miss stays loud/no-write
      // and requires manual/App redelivery rather than an operator-ledger fallback.
      log.info(
        {
          event: "attribution.route_forced_refresh",
          source,
          eventType,
          repo: target.repo,
          routeStatus: target.status,
        },
        "refreshing attribution route after verified cache miss"
      );
      target = await resolveTargetNode(source, verified.payload, {
        forceRefresh: true,
      });
    }

    const result = await receiveVerifiedWebhook(
      {
        attributionStore: container.attributionStore,
        target: target.target,
        // The operator's OWN node_id — when it equals the owning nodeId the receiver keeps the
        // local store write (no regression); a FOREIGN owner is delivered over HTTP instead.
        operatorNodeId: getNodeId(),
        receiptDelivery: container.receiptDelivery,
        logger: log,
      },
      verified
    );

    log.info(
      {
        event: "attribution.webhook_routed",
        source,
        eventType,
        eventCount: result.eventCount,
        nodeId: target.target?.nodeId ?? null,
        slug: target.target?.slug ?? null,
        repo: target.repo,
        routeStatus: target.status,
        persisted: result.persisted,
      },
      "webhook processed"
    );

    if (source === "github" && target.target === null) {
      const fields = {
        event: "attribution.route_unroutable",
        source,
        eventType,
        repo: target.repo,
        routeStatus: target.status,
        routeDetail: target.detail,
        receiptCount: result.receipts.length,
        receiptIds: result.receipts.map((receipt) => receipt.receiptId),
      } as const;
      if (
        target.status === "ambiguous" ||
        target.status === "profile_unavailable" ||
        target.status === "index_unavailable"
      ) {
        log.error(
          fields,
          "github attribution route unavailable — no ledger write"
        );
      } else {
        log.warn(
          fields,
          "github repository has no attribution owner — no ledger write"
        );
      }
    }

    // Ingestion telemetry: makes attribution receipts observable in Loki. Without
    // this, "are git contributions reaching the ledger?" was unanswerable from logs
    // (only the raw normalized count was logged, never which contributors/event types
    // were persisted). Idempotent — ON CONFLICT DO NOTHING may no-op on replay.
    if (result.persisted && result.receipts.length > 0) {
      log.info(
        {
          event: "attribution.receipt_ingested",
          source,
          nodeId: target.target?.nodeId ?? null,
          slug: target.target?.slug ?? null,
          repo: target.repo,
          routeStatus: target.status,
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
      dispatchPrReview(verified.payload, env, log);
      // Node-merge → preview tie: a merged spawned-node PR dispatches promote-and-deploy
      // at env=preview SOURCE-ADDRESSED by the PR head sha, pin on deploy/preview, ZERO
      // writes to main (PREVIEW_VIA_SOURCE_ADDRESSED_PROMOTE, task.5022).
      dispatchNodePreviewPromote(verified.payload, env, log);
      // Env-membership merge → lane reconcile: the `POST /nodes/{id}/envs` verb's own PR
      // landing is what provisions the lane's substrate (as its custodian) and renders its
      // desired state. Matches only that verb's branch on the parent monorepo; every other
      // merge no-ops (task.5132).
      dispatchLaneOnboard(verified.payload, env, log);
    }

    // node-template merge→main → mirror canonical content to every child fork (one PR each).
    if (source === "github" && eventType === "push") {
      dispatchCanonicalForkSync(verified.payload, env, log);
    }

    if (source === "alchemy") {
      dispatchSignalExecution(verified.payload, env, log);
    }

    if (
      source === "github" &&
      result.receipts.length > 0 &&
      (target.status === "unclaimed" ||
        target.status === "index_unavailable" ||
        target.status === "profile_unavailable")
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Attribution route not ready; manually redeliver after repair",
          attributionRoute: {
            status: target.status,
            repo: target.repo,
            persisted: false,
          },
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        eventCount: result.eventCount,
        attributionRoute: {
          status: target.status,
          repo: target.repo,
          persisted: result.persisted,
        },
      },
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

    // DB or other infra error — dispatch hooks only after an explicit positive verification proof.
    log.error(
      { source, eventType, error: String(error) },
      "webhook ingestion failed"
    );

    if (
      verifiedPayload !== null &&
      source === "github" &&
      eventType === "pull_request"
    ) {
      dispatchPrReview(verifiedPayload, env, log);
      dispatchNodePreviewPromote(verifiedPayload, env, log);
    }

    if (
      verifiedPayload !== null &&
      source === "github" &&
      eventType === "push"
    ) {
      dispatchCanonicalForkSync(verifiedPayload, env, log);
    }

    if (verifiedPayload !== null && source === "alchemy") {
      dispatchSignalExecution(verifiedPayload, env, log);
    }

    return NextResponse.json(
      { ok: false, error: "Ingestion failed" },
      { status: 500 }
    );
  }
}
