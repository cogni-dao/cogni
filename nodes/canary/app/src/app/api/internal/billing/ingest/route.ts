// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/billing/ingest`
 * Purpose: Internal endpoint receiving LiteLLM generic_api callbacks for billing.
 * Scope: Bearer-auth-protected POST endpoint. Validates payload, resolves billing context, calls commitUsageFact(). Does not contain billing logic.
 * Invariants:
 *   - CALLBACK_AUTHENTICATED: Requires Bearer BILLING_INGEST_TOKEN
 *   - INGEST_ENDPOINT_IS_INTERNAL: Docker-internal only, not exposed through Caddy
 *   - CHARGE_RECEIPTS_IDEMPOTENT_BY_CALL_ID: Duplicate callbacks are no-ops (handled internally by commitUsageFact)
 *   - COST_ORACLE_IS_LITELLM: Cost from callback response_cost field
 *   - NO_SYNCHRONOUS_RECEIPT_BARRIER: Never blocks LLM response (async callback)
 * Side-effects: IO (HTTP request/response, database via commitUsageFact)
 * Links: docs/spec/billing-ingest.md, billing-ingest.internal.v1.contract
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import type { GraphId } from "@cogni/ai-core";
import { toUserId } from "@cogni/ids";
import {
  BillingIngestBodySchema,
  type BillingIngestResponse,
  type StandardLoggingPayloadBilling,
} from "@cogni/node-contracts";
import type { RunContext, UsageFact } from "@cogni/node-core";
import { COGNI_SYSTEM_BILLING_ACCOUNT_ID } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import type { Logger } from "pino";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { commitUsageFact } from "@/features/ai/public.server";
import {
  getDisplayNameFromCache,
  isModelFreeFromCache,
} from "@/shared/ai/model-catalog.server";
import { serverEnv } from "@/shared/env";
import { billingInvariantViolationTotal } from "@/shared/observability/server/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Max auth header length to prevent DoS */
const MAX_AUTH_HEADER_LENGTH = 512;
/** Max token length after parsing (before comparison) */
const MAX_TOKEN_LENGTH = 256;

/**
 * Constant-time string comparison for bearer tokens.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;

  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;

  const token = trimmed.slice(7).trim();
  if (token.length > MAX_TOKEN_LENGTH) return null;

  return token;
}

/**
 * Resolve billingAccountId from callback entry.
 *
 * Per billing-ingest-spec "End User Routing (Verified Quirk)":
 * - Body-based callers (user field): end_user populated
 * - Header-based callers (x-litellm-end-user-id): end_user is empty string
 *   → fall back to metadata.requester_custom_headers["x-litellm-end-user-id"]
 */
function resolveBillingAccountId(
  entry: StandardLoggingPayloadBilling
): string | null {
  // Primary: end_user field (populated when request body has `user` field)
  if (entry.end_user && entry.end_user.length > 0) {
    return entry.end_user;
  }

  // Fallback: requester_custom_headers (for header-based callers)
  const headerEndUser =
    entry.metadata?.requester_custom_headers?.["x-litellm-end-user-id"];
  if (typeof headerEndUser === "string" && headerEndUser.length > 0) {
    return headerEndUser;
  }

  return null;
}

/**
 * Resolve a LiteLLM model_group (config alias) to its display name from the cached catalog.
 * Returns the raw model_group if catalog is unavailable or model not found.
 */
function resolveDisplayName(modelGroup: string): string {
  return getDisplayNameFromCache(modelGroup) ?? modelGroup;
}

/**
 * Construct a UsageFact from a LiteLLM callback entry.
 *
 * Key design: when spend_logs_metadata.run_id is available (InProc, Sandbox),
 * the computed source_reference matches the direct billing path → idempotent.
 * When run_id is missing (Gateway), litellm_call_id is used as fallback runId.
 * Per RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST: adapter path does not write receipts
 * when cost data is absent, so the callback is the sole receipt source for Gateway.
 */
function buildUsageFact(
  entry: StandardLoggingPayloadBilling,
  billingAccountId: string,
  virtualKeyId: string,
  log: Logger
): { fact: UsageFact; context: RunContext } {
  const metadata = entry.metadata?.spend_logs_metadata;

  // run_id from metadata when available; fallback to litellm_call_id
  const runId = metadata?.run_id ?? entry.id;
  const attempt = metadata?.attempt ?? 0;
  const graphId: GraphId =
    (metadata?.graph_id as GraphId) ?? "callback:billing-ingest";

  const hasTokens =
    entry.prompt_tokens + entry.completion_tokens > 0 || entry.total_tokens > 0;
  const isOpenRouter = entry.custom_llm_provider === "openrouter";
  const isFreeFromCache = isModelFreeFromCache(entry.model_group);
  const isFree = isFreeFromCache ?? false;
  const isSuspiciousZeroCost =
    entry.status === "success" &&
    isOpenRouter &&
    isFreeFromCache === false &&
    hasTokens &&
    entry.response_cost === 0;

  // Cache miss: do NOT treat as paid. Warn and continue normal processing.
  if (
    isOpenRouter &&
    hasTokens &&
    entry.response_cost === 0 &&
    isFreeFromCache === null
  ) {
    log.warn(
      {
        litellmCallId: entry.id,
        modelGroup: entry.model_group,
        model: entry.model,
        provider: entry.custom_llm_provider,
        promptTokens: entry.prompt_tokens,
        completionTokens: entry.completion_tokens,
        totalTokens: entry.total_tokens,
      },
      "Billing ingest: model catalog cache miss for response_cost=0 with tokens>0 — continuing"
    );
  }

  // Guardrail (bug.0060): never persist a final $0 receipt for paid models.
  // "Paid" is derived from LiteLLM config model_info.is_free (missing/unknown defaults to paid).
  // Defer instead, and emit an alertable metric/log so this can't be silent.
  const costUsd = isSuspiciousZeroCost ? undefined : entry.response_cost;
  if (isSuspiciousZeroCost) {
    billingInvariantViolationTotal.inc({ type: "openrouter_paid_zero_cost" });
    // Operator-facing: high-signal, no PII, includes forensic IDs.
    // (Tokens are safe; prompts are not logged anywhere.)
    log.error(
      {
        litellmCallId: entry.id,
        modelGroup: entry.model_group,
        model: entry.model,
        provider: entry.custom_llm_provider,
        isFreeModel: isFree,
        modelCatalogCacheHit: isFreeFromCache !== null,
        promptTokens: entry.prompt_tokens,
        completionTokens: entry.completion_tokens,
        totalTokens: entry.total_tokens,
      },
      "Billing ingest: suspicious $0 response_cost for paid OpenRouter model — deferring receipt"
    );
  }

  const fact: UsageFact = {
    runId,
    attempt,
    usageUnitId: entry.id, // litellm_call_id
    source: "litellm",
    executorType: "inproc", // Best-effort; callback doesn't carry executor type
    billingAccountId,
    virtualKeyId,
    graphId,
    provider: entry.custom_llm_provider,
    model: resolveDisplayName(entry.model_group), // Display name from catalog, falls back to model_group
    inputTokens: entry.prompt_tokens,
    outputTokens: entry.completion_tokens,
    ...(costUsd !== undefined && { costUsd }),
  };

  const context: RunContext = {
    runId,
    attempt,
    ingressRequestId: runId,
  };

  return { fact, context };
}

/**
 * POST /api/internal/billing/ingest
 *
 * Receives LiteLLM generic_api callback payloads.
 * Validates bearer token, parses batched array, writes receipts via commitUsageFact().
 *
 * Returns:
 * - 200: { processed, skipped }
 * - 401: Invalid/missing token
 * - 400: Invalid payload
 */
export const POST = wrapRouteHandlerWithLogging(
  { routeId: "billing.ingest.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    const container = getContainer();
    const log = ctx.log;

    // --- 1. Bearer token auth ---
    const configuredToken = env.BILLING_INGEST_TOKEN;
    const authHeader = request.headers.get("authorization");
    const providedToken = extractBearerToken(authHeader);

    if (!providedToken || !safeCompare(providedToken, configuredToken)) {
      log.warn("Billing ingest: invalid or missing BILLING_INGEST_TOKEN");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // --- 2. Parse body ---
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parseResult = BillingIngestBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      log.warn(
        { errors: parseResult.error.issues },
        "Billing ingest: invalid payload"
      );
      return NextResponse.json(
        { error: "Invalid payload", details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const entries = parseResult.data;

    // --- 3. Process each entry ---
    // commitUsageFact never throws (BILLING_NEVER_THROWS) — duplicates are
    // idempotent no-ops at the DB level, errors are logged internally.
    let processed = 0;
    let skipped = 0;

    for (const entry of entries) {
      // Skip non-success entries (failures don't cost money)
      if (entry.status !== "success") {
        skipped++;
        log.debug(
          { callId: entry.id, status: entry.status },
          "Billing ingest: skipping non-success entry"
        );
        continue;
      }

      // Resolve billing account; fall back to system account for unattributed calls
      // (e.g. Discord → OpenClaw gateway → LiteLLM with no end-user header)
      const resolvedBillingAccountId = resolveBillingAccountId(entry);
      const billingAccountId =
        resolvedBillingAccountId ?? COGNI_SYSTEM_BILLING_ACCOUNT_ID;
      if (!resolvedBillingAccountId) {
        log.warn(
          { callId: entry.id },
          "Billing ingest: no billingAccountId resolved — attributing to system account"
        );
      }

      // Look up billing account to get virtualKeyId and ownerUserId
      const billingAccount =
        await container.serviceAccountService.getBillingAccountById(
          billingAccountId
        );
      if (!billingAccount) {
        skipped++;
        log.warn(
          { callId: entry.id, billingAccountId },
          "Billing ingest: billing account not found — skipping"
        );
        continue;
      }

      // Build UsageFact from callback payload
      const { fact, context } = buildUsageFact(
        entry,
        billingAccountId,
        billingAccount.defaultVirtualKeyId,
        log
      );

      // Get user-scoped account service for recordChargeReceipt (RLS)
      const accountService = container.accountsForUser(
        toUserId(billingAccount.ownerUserId)
      );

      // commitUsageFact handles idempotency internally — duplicates are logged, not thrown
      await commitUsageFact(fact, context, accountService, log);
      processed++;
    }

    log.info(
      { processed, skipped, total: entries.length },
      "Billing ingest batch complete"
    );

    const response: BillingIngestResponse = { processed, skipped };
    return NextResponse.json(response, { status: 200 });
  }
);
