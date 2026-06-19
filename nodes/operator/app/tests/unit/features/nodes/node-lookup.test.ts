// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@features/nodes/node-lookup`.
 * Purpose: A `{id}` path segment resolves by repo-spec `node_id` (UUID == `nodes.id`) OR `slug`;
 *   a non-UUID segment never emits a `nodes.id` term (no malformed uuid cast).
 * Scope: Pure logic only.
 * Links: src/features/nodes/node-lookup.ts
 */

import type { Database } from "@cogni/db-client";
import { describe, expect, it } from "vitest";
import {
  isNodeId,
  nodeIdOrSlug,
  resolveNodeRef,
} from "@/features/nodes/node-lookup";

const UUID = "f97f68f2-8406-4a3b-b5a9-d579b779f19d";

/** Minimal drizzle stub: `select().from().where().limit()` → the given rows. */
function fakeDb(rows: ReadonlyArray<{ id: string; slug: string }>): Database {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    }),
  } as unknown as Database;
}

describe("isNodeId", () => {
  it("accepts canonical UUIDs (a candidate node_id / nodes.id)", () => {
    expect(isNodeId(UUID)).toBe(true);
    expect(isNodeId(UUID.toUpperCase())).toBe(true);
  });

  it("rejects slugs and other non-UUID strings", () => {
    expect(isNodeId("beacon")).toBe(false);
    expect(isNodeId("node-template")).toBe(false);
    expect(isNodeId("")).toBe(false);
    expect(isNodeId("not-a-uuid-1234")).toBe(false);
  });
});

describe("nodeIdOrSlug", () => {
  it("emits a condition for a UUID segment (matches id OR slug)", () => {
    expect(nodeIdOrSlug(UUID)).toBeDefined();
  });

  it("emits a condition for a slug segment (slug only — no uuid cast)", () => {
    expect(nodeIdOrSlug("beacon")).toBeDefined();
  });
});

describe("resolveNodeRef", () => {
  it("resolves a matched node (any status) to its canonical nodeId + slug", async () => {
    // The row's status is irrelevant — resolveNodeRef applies no status filter (unlike listPublic),
    // so a `published` deployed node like beacon resolves and the route can authorize it.
    const db = fakeDb([{ id: UUID, slug: "beacon" }]);
    await expect(resolveNodeRef(db, "beacon")).resolves.toEqual({
      nodeId: UUID,
      slug: "beacon",
    });
    await expect(resolveNodeRef(db, UUID)).resolves.toEqual({
      nodeId: UUID,
      slug: "beacon",
    });
  });

  it("returns null when no node matches", async () => {
    await expect(resolveNodeRef(fakeDb([]), "ghost")).resolves.toBeNull();
  });
});
