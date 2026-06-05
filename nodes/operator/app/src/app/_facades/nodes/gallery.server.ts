// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/nodes/gallery.server`
 * Purpose: Server-side read composition for the public nodes gallery and detail pages.
 * Scope: Resolves node registry summaries, joins optional attribution metrics, and degrades missing
 *   ledger data to unavailable metrics. Does not mutate node registry or attribution state.
 * Invariants: PROJECTION_NOT_SSOT, RECEIPT_APPEND_ONLY, NO_AI_USAGE_INFERENCE.
 * Side-effects: IO (registry and database reads)
 * Links: src/ports/node-registry.port.ts, docs/spec/attribution-ledger.md, docs/spec/activity-metrics.md
 * @public
 */

import { ingestionReceipts } from "@cogni/db-schema/attribution";
import type { EpochClaimantLineItemDto } from "@cogni/node-contracts";
import { and, gte, inArray, sql } from "drizzle-orm";
import { readFinalizedEpochClaimants } from "@/app/_facades/attribution/claimants.server";
import {
  getContainer,
  resolveNodeRegistry,
  resolveServiceDb,
} from "@/bootstrap/container";
import type { NodeSummary } from "@/ports";

const RECENT_WINDOW_DAYS = 30;
const TOP_OWNER_LIMIT = 8;

export interface NodeMetricSummary {
  readonly devActivity30d: number;
  readonly devActivityTotal: number;
  readonly aiUsage:
    | { readonly state: "available"; readonly requests30d: number }
    | { readonly state: "unavailable"; readonly reason: string };
  readonly latestEpoch: {
    readonly id: string;
    readonly status: "open" | "review" | "finalized";
    readonly periodStart: string;
    readonly periodEnd: string;
  } | null;
  readonly finalizedEpochCount: number;
}

export interface NodeOwnerSummary {
  readonly claimantKey: string;
  readonly displayName: string | null;
  readonly claimantLabel: string;
  readonly isLinked: boolean;
  readonly totalCredits: number;
  readonly ownershipPercent: number;
  readonly epochsContributed: number;
}

export interface NodeGalleryItem {
  readonly node: NodeSummary;
  readonly metrics: NodeMetricSummary;
}

export interface NodeDetail extends NodeGalleryItem {
  readonly topOwners: readonly NodeOwnerSummary[];
}

function emptyMetrics(): NodeMetricSummary {
  return {
    devActivity30d: 0,
    devActivityTotal: 0,
    aiUsage: {
      state: "unavailable",
      reason: "AI usage needs node-correlated charge receipts",
    },
    latestEpoch: null,
    finalizedEpochCount: 0,
  };
}

function normalizeCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  return 0;
}

async function readReceiptCounts(
  nodeIds: readonly string[]
): Promise<
  Map<string, Pick<NodeMetricSummary, "devActivity30d" | "devActivityTotal">>
> {
  if (nodeIds.length === 0) return new Map();

  const db = resolveServiceDb();
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [recentRows, totalRows] = await Promise.all([
    db
      .select({
        nodeId: ingestionReceipts.nodeId,
        count: sql<number>`count(*)::int`,
      })
      .from(ingestionReceipts)
      .where(
        and(
          inArray(ingestionReceipts.nodeId, [...nodeIds]),
          gte(ingestionReceipts.eventTime, since)
        )
      )
      .groupBy(ingestionReceipts.nodeId),
    db
      .select({
        nodeId: ingestionReceipts.nodeId,
        count: sql<number>`count(*)::int`,
      })
      .from(ingestionReceipts)
      .where(inArray(ingestionReceipts.nodeId, [...nodeIds]))
      .groupBy(ingestionReceipts.nodeId),
  ]);

  const counts = new Map<
    string,
    Pick<NodeMetricSummary, "devActivity30d" | "devActivityTotal">
  >();

  for (const row of totalRows) {
    counts.set(row.nodeId, {
      devActivity30d: 0,
      devActivityTotal: normalizeCount(row.count),
    });
  }
  for (const row of recentRows) {
    const current = counts.get(row.nodeId) ?? {
      devActivity30d: 0,
      devActivityTotal: 0,
    };
    counts.set(row.nodeId, {
      ...current,
      devActivity30d: normalizeCount(row.count),
    });
  }

  return counts;
}

async function readEpochMetrics(
  nodeId: string | undefined
): Promise<Pick<NodeMetricSummary, "latestEpoch" | "finalizedEpochCount">> {
  if (!nodeId) {
    return { latestEpoch: null, finalizedEpochCount: 0 };
  }

  try {
    const epochs = await getContainer().attributionStore.listEpochs(nodeId);
    const latest =
      [...epochs].sort((a, b) => Number(b.id - a.id)).at(0) ?? null;
    return {
      latestEpoch: latest
        ? {
            id: latest.id.toString(),
            status: latest.status,
            periodStart: latest.periodStart.toISOString(),
            periodEnd: latest.periodEnd.toISOString(),
          }
        : null,
      finalizedEpochCount: epochs.filter(
        (epoch) => epoch.status === "finalized"
      ).length,
    };
  } catch {
    return { latestEpoch: null, finalizedEpochCount: 0 };
  }
}

function aggregateOwners(
  claimantSets: readonly {
    readonly epochId: string;
    readonly items: readonly EpochClaimantLineItemDto[];
  }[]
): readonly NodeOwnerSummary[] {
  const byKey = new Map<
    string,
    Omit<NodeOwnerSummary, "ownershipPercent"> & {
      readonly epochs: Set<string>;
    }
  >();
  let totalCredits = 0;

  for (const claimantSet of claimantSets) {
    for (const item of claimantSet.items) {
      const credits = normalizeCount(item.amountCredits);
      totalCredits += credits;
      const existing = byKey.get(item.claimantKey);
      if (existing) {
        existing.epochs.add(claimantSet.epochId);
        byKey.set(item.claimantKey, {
          ...existing,
          displayName: existing.displayName ?? item.displayName,
          isLinked: existing.isLinked || item.isLinked,
          totalCredits: existing.totalCredits + credits,
          epochsContributed: existing.epochs.size,
        });
      } else {
        byKey.set(item.claimantKey, {
          claimantKey: item.claimantKey,
          displayName: item.displayName,
          claimantLabel:
            item.claimant.kind === "user"
              ? "Linked account"
              : "Unlinked account",
          isLinked: item.isLinked,
          totalCredits: credits,
          epochsContributed: 1,
          epochs: new Set([claimantSet.epochId]),
        });
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.totalCredits - a.totalCredits)
    .slice(0, TOP_OWNER_LIMIT)
    .map(({ epochs: _epochs, ...owner }) => ({
      ...owner,
      ownershipPercent:
        totalCredits > 0
          ? Math.round((owner.totalCredits / totalCredits) * 1000) / 10
          : 0,
    }));
}

async function readTopOwners(
  nodeId: string | undefined
): Promise<readonly NodeOwnerSummary[]> {
  if (!nodeId) return [];

  try {
    const epochs = await getContainer().attributionStore.listEpochs(nodeId);
    const finalized = [...epochs]
      .filter((epoch) => epoch.status === "finalized")
      .sort((a, b) => Number(b.id - a.id))
      .slice(0, 12);
    const claimantSets = await Promise.all(
      finalized.map(async (epoch) => ({
        epochId: epoch.id.toString(),
        items: (await readFinalizedEpochClaimants(epoch.id)).items,
      }))
    );
    return aggregateOwners(claimantSets);
  } catch {
    return [];
  }
}

function mergeMetrics(
  base: NodeMetricSummary,
  receiptCounts:
    | Pick<NodeMetricSummary, "devActivity30d" | "devActivityTotal">
    | undefined,
  epochMetrics: Pick<NodeMetricSummary, "latestEpoch" | "finalizedEpochCount">
): NodeMetricSummary {
  return {
    ...base,
    ...receiptCounts,
    ...epochMetrics,
  };
}

export async function listNodeGallery(): Promise<readonly NodeGalleryItem[]> {
  const nodes = await resolveNodeRegistry().listPublic();
  const nodeIds = nodes
    .map((node) => node.nodeId)
    .filter((nodeId): nodeId is string => Boolean(nodeId));
  const receiptCounts = await readReceiptCounts(nodeIds);
  const epochMetrics = await Promise.all(
    nodes.map((node) => readEpochMetrics(node.nodeId))
  );

  return nodes.map((node, index) => ({
    node,
    metrics: mergeMetrics(
      emptyMetrics(),
      node.nodeId ? receiptCounts.get(node.nodeId) : undefined,
      epochMetrics[index] ?? { latestEpoch: null, finalizedEpochCount: 0 }
    ),
  }));
}

export async function getNodeDetail(slug: string): Promise<NodeDetail | null> {
  const items = await listNodeGallery();
  const item = items.find((candidate) => candidate.node.slug === slug);
  if (!item) return null;
  const topOwners = await readTopOwners(item.node.nodeId);
  return { ...item, topOwners };
}
