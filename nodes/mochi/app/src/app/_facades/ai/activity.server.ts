// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/ai/activity.server`
 * Purpose: App-layer facade for Activity dashboard with granular time bucketing and optional per-model/agent breakdown.
 * Scope: Resolves session user to billing account, fetches receipts + LLM details, aggregates into buckets. Supports groupBy (model|graphId) for stacked chart series. Does not handle HTTP transport.
 * Invariants:
 * - Only app layer imports this; validates billing account.
 * - Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: charge_receipts is the primary data source for Activity.
 * - Uses epoch-based bucketing (UTC, DST-safe) with server-derived step.
 * - Zero-fills buckets across entire range for continuous charts.
 * - LLM detail (model/tokens) enriched via separate listLlmChargeDetails fetch, merged in memory.
 * - Logs receiptCount for observability.
 * Side-effects: IO (via accountService)
 * Links: [validateActivityRange](../../../features/ai/services/activity.ts), [ai.activity.v1.contract](../../../contracts/ai.activity.v1.contract.ts)
 * @public
 */

import { randomUUID } from "node:crypto";
import { toUserId } from "@cogni/ids";
import {
  type ActivityGroupBy,
  type aiActivityOperation,
  STEP_MS,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import type { z } from "zod";
import { resolveActivityDeps } from "@/bootstrap/container";
import { validateActivityRange } from "@/features/ai/public.server";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import {
  type AiActivityQueryCompletedEvent,
  EVENT_NAMES,
  makeLogger,
} from "@/shared/observability";

const logger = makeLogger({ component: "ActivityFacade" });

type ActivityInput = {
  from: string;
  to: string;
  step?: z.infer<typeof aiActivityOperation.input>["step"];
  groupBy?: ActivityGroupBy;
  cursor?: string;
  limit?: number;
  sessionUser: SessionUser;
  /** Optional correlation ID - generated if not provided */
  reqId?: string;
  /** Billing scope — "user" or "system". Used for observability logging. */
  scope?: "user" | "system";
};

type ActivityOutput = z.infer<typeof aiActivityOperation.output>;

/**
 * Compute epoch bucket key for a timestamp.
 * Aligns to UTC boundaries (DST-safe).
 */
function toBucketEpoch(timestamp: Date, stepMs: number): number {
  return Math.floor(timestamp.getTime() / stepMs) * stepMs;
}

/**
 * Generate all bucket epochs in [from, to) range.
 * Returns sorted array of epoch timestamps.
 * Note: Range is [from, to) - inclusive start, exclusive end.
 */
function generateBucketRange(from: Date, to: Date, stepMs: number): number[] {
  const buckets: number[] = [];
  const startBucket = toBucketEpoch(from, stepMs);
  const endBucket = toBucketEpoch(to, stepMs);

  // Use < not <= since range is [from, to) - exclude end bucket
  for (let epoch = startBucket; epoch < endBucket; epoch += stepMs) {
    buckets.push(epoch);
  }
  return buckets;
}

type Bucket = { tokens: number; requests: number; spend: number };
const EMPTY_BUCKET: Readonly<Bucket> = { tokens: 0, requests: 0, spend: 0 };

/** Max distinct groups before remainder is folded into "Others". */
const MAX_GROUPS = 5;

type DetailMap = Map<
  string,
  {
    model: string;
    provider: string | null;
    graphId: string;
    tokensIn: number | null;
    tokensOut: number | null;
    latencyMs: number | null;
  }
>;

/**
 * Build per-group time series from receipts, sorted by total spend descending.
 * Groups beyond MAX_GROUPS are merged into "Others".
 */
function buildGroupedSeries(
  receipts: ReadonlyArray<{
    id: string;
    createdAt: Date;
    responseCostUsd: string | null;
  }>,
  detailMap: DetailMap,
  groupBy: ActivityGroupBy,
  stepMs: number,
  allBucketEpochs: readonly number[]
): NonNullable<ActivityOutput["groupedSeries"]> {
  // Accumulate: group → epoch → bucket
  const grouped = new Map<string, Map<number, Bucket>>();

  function getOrCreateEpochMap(group: string): Map<number, Bucket> {
    const existing = grouped.get(group);
    if (existing) return existing;
    const fresh = new Map<number, Bucket>();
    grouped.set(group, fresh);
    return fresh;
  }

  for (const receipt of receipts) {
    const detail = detailMap.get(receipt.id);
    const group =
      groupBy === "model"
        ? (detail?.model ?? "unknown")
        : (detail?.graphId ?? "unknown");
    const epoch = toBucketEpoch(receipt.createdAt, stepMs);
    const epochMap = getOrCreateEpochMap(group);
    const prev = epochMap.get(epoch) ?? { ...EMPTY_BUCKET };

    prev.tokens += (detail?.tokensIn ?? 0) + (detail?.tokensOut ?? 0);
    prev.requests += 1;
    prev.spend += receipt.responseCostUsd
      ? Number.parseFloat(receipt.responseCostUsd)
      : 0;

    epochMap.set(epoch, prev);
  }

  // Rank groups by total spend descending
  const ranked = [...grouped.entries()]
    .map(([group, epochs]) => {
      let totalSpend = 0;
      for (const b of epochs.values()) totalSpend += b.spend;
      return { group, totalSpend, epochs };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);

  const topEntries = ranked.slice(0, MAX_GROUPS);
  const overflowEntries = ranked.slice(MAX_GROUPS);

  // Merge overflow into "Others" if needed
  if (overflowEntries.length > 0) {
    const othersEpochs = new Map<number, Bucket>();
    for (const { epochs } of overflowEntries) {
      for (const [epoch, b] of epochs) {
        const prev = othersEpochs.get(epoch) ?? { ...EMPTY_BUCKET };
        prev.tokens += b.tokens;
        prev.requests += b.requests;
        prev.spend += b.spend;
        othersEpochs.set(epoch, prev);
      }
    }
    topEntries.push({ group: "Others", totalSpend: 0, epochs: othersEpochs });
  }

  // Zero-fill each group across all bucket epochs
  return topEntries.map(({ group, epochs }) => ({
    group,
    buckets: allBucketEpochs.map((epoch) => {
      const b = epochs.get(epoch) ?? EMPTY_BUCKET;
      return {
        bucketStart: new Date(epoch).toISOString(),
        spend: b.spend,
        tokens: b.tokens,
        requests: b.requests,
      };
    }),
  }));
}

export async function getActivity(
  input: ActivityInput
): Promise<ActivityOutput> {
  const startTime = performance.now();
  const effectiveReqId = input.reqId ?? randomUUID();
  const { accountService } = resolveActivityDeps(
    toUserId(input.sessionUser.id)
  );

  const billingAccount = await getOrCreateBillingAccountForUser(
    accountService,
    {
      userId: input.sessionUser.id,
      ...(input.sessionUser.walletAddress
        ? { walletAddress: input.sessionUser.walletAddress }
        : {}),
    }
  );

  // Parse dates once and validate range (derives step if not provided)
  const from = new Date(input.from);
  const to = new Date(input.to);
  const { effectiveStep, diffDays } = validateActivityRange({
    from,
    to,
    step: input.step,
  });

  const stepMs = STEP_MS[effectiveStep];

  // Fetch charge receipts (primary source per CHARGE_RECEIPTS_IS_LEDGER_TRUTH)
  // MVP: capped at adapter max (1000). Heavy users may see truncated charts.
  // TODO: SQL GROUP BY aggregation or materialized view for unbounded ranges.
  const receipts = await accountService.listChargeReceipts({
    billingAccountId: billingAccount.id,
    from,
    to,
    limit: 1000,
  });

  const receiptCount = receipts.length;

  // Fetch LLM details for receipts that have receipt_kind='llm'
  const llmReceiptIds = receipts
    .filter((r) => r.receiptKind === "llm")
    .map((r) => r.id);

  const llmDetails =
    llmReceiptIds.length > 0
      ? await accountService.listLlmChargeDetails({
          chargeReceiptIds: llmReceiptIds,
        })
      : [];

  // Build detail map: chargeReceiptId → detail
  const detailMap = new Map(llmDetails.map((d) => [d.chargeReceiptId, d]));

  // Aggregate receipts into epoch buckets
  const buckets = new Map<
    number,
    { tokens: number; requests: number; spend: number }
  >();

  for (const receipt of receipts) {
    const bucketEpoch = toBucketEpoch(receipt.createdAt, stepMs);
    const existing = buckets.get(bucketEpoch) ?? {
      tokens: 0,
      requests: 0,
      spend: 0,
    };

    const detail = detailMap.get(receipt.id);
    const tokensIn = detail?.tokensIn ?? 0;
    const tokensOut = detail?.tokensOut ?? 0;
    const spend = receipt.responseCostUsd
      ? Number.parseFloat(receipt.responseCostUsd)
      : 0;

    buckets.set(bucketEpoch, {
      tokens: existing.tokens + tokensIn + tokensOut,
      requests: existing.requests + 1,
      spend: existing.spend + spend,
    });
  }

  // Zero-fill: generate all buckets in range
  const allBucketEpochs = generateBucketRange(from, to, stepMs);
  const chartSeries = allBucketEpochs.map((epoch) => {
    const bucket = buckets.get(epoch) ?? { tokens: 0, requests: 0, spend: 0 };
    return {
      bucketStart: new Date(epoch).toISOString(),
      spend: bucket.spend.toFixed(6),
      tokens: bucket.tokens,
      requests: bucket.requests,
    };
  });

  const groupedSeries = input.groupBy
    ? buildGroupedSeries(
        receipts,
        detailMap,
        input.groupBy,
        stepMs,
        allBucketEpochs
      )
    : undefined;

  // Calculate totals from all receipts in range
  let totalUserSpend = 0;
  let totalTokens = 0;
  for (const receipt of receipts) {
    if (receipt.responseCostUsd) {
      totalUserSpend += Number.parseFloat(receipt.responseCostUsd);
    }
    const detail = detailMap.get(receipt.id);
    totalTokens += (detail?.tokensIn ?? 0) + (detail?.tokensOut ?? 0);
  }
  const totalRequests = receipts.length;

  const avgDays = Math.max(1, diffDays);

  const totals = {
    spend: {
      total: totalUserSpend.toFixed(6),
      avgDay: (totalUserSpend / avgDays).toFixed(6),
      pastRange: "0",
    },
    tokens: {
      total: totalTokens,
      avgDay: Math.round(totalTokens / avgDays),
      pastRange: 0,
    },
    requests: {
      total: totalRequests,
      avgDay: Math.round(totalRequests / avgDays),
      pastRange: 0,
    },
  };

  // Build rows — receipts already sorted by createdAt DESC from adapter
  const pageSize = input.limit ?? 20;
  const paginatedReceipts = receipts.slice(0, pageSize);

  const rows = paginatedReceipts.map((receipt) => {
    const detail = detailMap.get(receipt.id);
    const tokensOut = detail?.tokensOut ?? 0;
    const latencyMs = detail?.latencyMs ?? 0;
    const speed =
      tokensOut > 0 && latencyMs > 0 ? tokensOut / (latencyMs / 1000) : 0;

    return {
      id: receipt.id,
      timestamp: receipt.createdAt.toISOString(),
      provider: detail?.provider ?? receipt.sourceSystem,
      model: detail?.model ?? "unknown",
      graphId: detail?.graphId ?? "unknown:unknown",
      tokensIn: detail?.tokensIn ?? 0,
      tokensOut,
      cost: receipt.responseCostUsd ?? "—",
      speed,
    };
  });

  // Generate nextCursor if there are more rows
  let nextCursor: string | null = null;
  if (receipts.length > pageSize) {
    const lastRow = paginatedReceipts.at(-1);
    if (lastRow) {
      const json = JSON.stringify({
        createdAt: lastRow.createdAt.toISOString(),
        id: lastRow.id,
      });
      nextCursor = Buffer.from(json).toString("base64");
    }
  }

  const result: ActivityOutput = {
    effectiveStep,
    chartSeries,
    groupedSeries,
    totals,
    rows,
    nextCursor,
  };

  // Log completion event with observability metrics
  const logEvent: AiActivityQueryCompletedEvent = {
    event: EVENT_NAMES.AI_ACTIVITY_QUERY_COMPLETED,
    reqId: effectiveReqId,
    routeId: "ai.activity.v1",
    scope: input.scope ?? "user",
    billingAccountId: billingAccount.id,
    effectiveStep,
    durationMs: performance.now() - startTime,
    resultCount: rows.length,
    fetchedLogCount: receiptCount,
    unjoinedLogCount: 0,
    status: "success",
  };
  logger.info(logEvent, EVENT_NAMES.AI_ACTIVITY_QUERY_COMPLETED);

  return result;
}
