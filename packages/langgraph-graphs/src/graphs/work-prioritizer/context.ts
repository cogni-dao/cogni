// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/context`
 * Purpose: Pure parsing of the prioritizer's tool results into one bounded, de-duplicated run context.
 * Scope: Does not call tools, LLMs, or read env; parses tool JSON, dedupes, derives blocker cycles + duplicate groups.
 * Invariants:
 *   - IDS_FROM_TOOLS_ONLY: every id in the context came from a tool result this run.
 *   - DEDUPE_BY_ID: a work item / entry returned twice appears once (latest revision wins).
 *   - EDO_PLANE_WINS: an id returned by both a knowledge read and an EDO read is classified `edo`.
 * Side-effects: none
 * Links: tools.ts (CONTEXT_READS), guards.ts
 * @public
 */

import { createHash } from "node:crypto";

import type { ContextConsumed } from "./schema";
import type { ContextPlane } from "./tools";

/** A work item as fetched this run (the subset the prioritizer reasons over). */
export interface FetchedWorkItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  /** `null` when the store did not return a revision (such items cannot be acted on). */
  readonly revision: number | null;
  readonly priority?: number;
  readonly rank?: number;
  readonly summary?: string;
  readonly outcome?: string;
  readonly parentId?: string;
  readonly blockedBy?: string;
  readonly labels: readonly string[];
  readonly updatedAt?: string;
}

/** A knowledge / EDO entry as fetched this run. */
export interface FetchedEntry {
  readonly id: string;
  readonly domain: string;
  readonly title: string;
  readonly content: string;
  readonly confidencePct: number | null;
  readonly tags: readonly string[];
  readonly plane: ContextPlane;
}

export interface ToolCallError {
  readonly tool: string;
  readonly error: string;
}

export interface GatheredContext {
  /** ISO time from core__get_current_time (falls back to the host clock if that tool failed). */
  readonly now: string;
  readonly workItems: readonly FetchedWorkItem[];
  readonly entries: readonly FetchedEntry[];
  readonly contextConsumed: ContextConsumed;
  /** Cycles in the `blockedBy` graph among fetched items (each cycle = member ids). */
  readonly blockerCycles: readonly (readonly string[])[];
  /** DUPLICATE_PREPASS: groups of ≥2 fetched items whose normalized titles are identical. */
  readonly duplicateCandidates: readonly (readonly string[])[];
  /** Hash of the sorted `id@revision` set — identifies the backlog state this cycle judged. */
  readonly snapshotId: string;
}

/** SNAPSHOT_ID: sha256 over sorted `id@revision`, first 16 hex chars. */
export function computeSnapshotId(items: readonly FetchedWorkItem[]): string {
  const key = items
    .map((i) => `${i.id}@${i.revision ?? "null"}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Result of one tool invocation, decoded from the wrapper's JSON string. */
export type DecodedToolResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/**
 * Decode the LangChain tool wrapper's string result. The wrapper returns
 * `JSON.stringify(value)` on success and `{ error, message }` on failure/denial.
 */
export function decodeToolResult(raw: unknown): DecodedToolResult {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: `non_json_tool_result: ${raw.slice(0, 120)}` };
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  ) {
    const v = value as { error: string; message?: unknown };
    return {
      ok: false,
      error: `${v.error}${typeof v.message === "string" ? `: ${v.message}` : ""}`,
    };
  }
  return { ok: true, value };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** Parse a core__work_item_query result value into fetched items. */
export function parseWorkItems(value: unknown): FetchedWorkItem[] {
  const items = (value as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: FetchedWorkItem[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    const title = typeof r.title === "string" ? r.title : undefined;
    const status = str(r.status);
    if (!id || title === undefined || !status) continue;
    const revision = num(r.revision);
    const item: FetchedWorkItem = {
      id,
      type: str(r.type) ?? "unknown",
      title,
      status,
      revision: revision !== undefined ? Math.trunc(revision) : null,
      labels: strArray(r.labels),
      ...(num(r.priority) !== undefined && { priority: num(r.priority) }),
      ...(num(r.rank) !== undefined && { rank: num(r.rank) }),
      ...(str(r.summary) && { summary: str(r.summary) }),
      ...(str(r.outcome) && { outcome: str(r.outcome) }),
      ...(str(r.parentId) && { parentId: str(r.parentId) }),
      ...(str(r.blockedBy) && { blockedBy: str(r.blockedBy) }),
      ...(str(r.updatedAt) && { updatedAt: str(r.updatedAt) }),
    };
    out.push(item);
  }
  return out;
}

/** Parse a core__knowledge_search (`results`) or core__knowledge_read (`entries`) value. */
export function parseEntries(
  value: unknown,
  plane: ContextPlane
): FetchedEntry[] {
  const v = value as { results?: unknown; entries?: unknown };
  const rows = Array.isArray(v?.results)
    ? v.results
    : Array.isArray(v?.entries)
      ? v.entries
      : [];
  const out: FetchedEntry[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    out.push({
      id,
      domain: str(r.domain) ?? "unknown",
      title: typeof r.title === "string" ? r.title : "",
      content: typeof r.content === "string" ? r.content : "",
      confidencePct: num(r.confidencePct) ?? null,
      tags: strArray(r.tags),
      plane,
    });
  }
  return out;
}

/** An approved DAO goal as `core__goal_list` returns it (dao-goals-design; the store enforces ≤3). */
export interface ActiveGoal {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

/** Parse a `core__goal_list` result value into goals. */
export function parseGoals(value: unknown): ActiveGoal[] {
  const goals = (value as { goals?: unknown })?.goals;
  return (Array.isArray(goals) ? goals : []).flatMap((g) => {
    const r = g as Record<string, unknown>;
    return typeof r.id === "string" && r.id.startsWith("goal-")
      ? [
          {
            id: r.id,
            title: String(r.title ?? ""),
            content: String(r.content ?? ""),
          },
        ]
      : [];
  });
}

/** Dedupe items by id; when an id repeats, the higher revision wins. */
export function dedupeWorkItems(
  items: readonly FetchedWorkItem[]
): FetchedWorkItem[] {
  const byId = new Map<string, FetchedWorkItem>();
  for (const item of items) {
    const prev = byId.get(item.id);
    if (!prev || (item.revision ?? -1) > (prev.revision ?? -1)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

/** Dedupe entries by id; an id seen on the EDO plane is classified `edo`. */
export function dedupeEntries(
  entries: readonly FetchedEntry[]
): FetchedEntry[] {
  const byId = new Map<string, FetchedEntry>();
  for (const e of entries) {
    const prev = byId.get(e.id);
    if (!prev) {
      byId.set(e.id, e);
    } else if (prev.plane !== "edo" && e.plane === "edo") {
      byId.set(e.id, { ...prev, plane: "edo" });
    }
  }
  return [...byId.values()];
}

/**
 * Find cycles in the `blockedBy` graph restricted to fetched items. Each item has at most
 * one `blockedBy`, so the graph is a functional graph and every cycle is found by walking.
 */
export function findBlockerCycles(
  items: readonly FetchedWorkItem[]
): string[][] {
  const next = new Map<string, string>();
  for (const i of items) if (i.blockedBy) next.set(i.id, i.blockedBy);
  const cycles: string[][] = [];
  const settled = new Set<string>();
  for (const start of next.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cur: string | undefined = start;
    while (cur !== undefined && !settled.has(cur) && !onPath.has(cur)) {
      onPath.set(cur, path.length);
      path.push(cur);
      cur = next.get(cur);
    }
    if (cur !== undefined && onPath.has(cur)) {
      cycles.push(path.slice(onPath.get(cur)));
    }
    for (const id of path) settled.add(id);
  }
  return cycles;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Group fetched items whose normalized titles are identical (≥2 members per group). */
export function findDuplicateTitleGroups(
  items: readonly FetchedWorkItem[]
): string[][] {
  const groups = new Map<string, string[]>();
  for (const i of items) {
    const key = normalizeTitle(i.title);
    if (!key) continue;
    const g = groups.get(key) ?? [];
    g.push(i.id);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Build the run context from the decoded tool results. */
export function buildGatheredContext(input: {
  readonly now: string;
  readonly workItems: readonly FetchedWorkItem[];
  readonly entries: readonly FetchedEntry[];
}): GatheredContext {
  const workItems = dedupeWorkItems(input.workItems);
  const entries = dedupeEntries(input.entries);
  return {
    now: input.now,
    workItems,
    entries,
    contextConsumed: {
      workItemIds: workItems.map((i) => i.id),
      knowledgeIds: entries
        .filter((e) => e.plane === "knowledge")
        .map((e) => e.id),
      edoIds: entries.filter((e) => e.plane === "edo").map((e) => e.id),
    },
    blockerCycles: findBlockerCycles(workItems),
    duplicateCandidates: findDuplicateTitleGroups(workItems),
    snapshotId: computeSnapshotId(workItems),
  };
}
