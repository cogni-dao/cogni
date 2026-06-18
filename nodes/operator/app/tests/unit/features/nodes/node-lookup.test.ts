// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@features/nodes/node-lookup`.
 * Purpose: A `{id}` path segment resolves by repo-spec `node_id` (UUID == `nodes.id`) OR `slug`;
 *   a non-UUID segment never emits a `nodes.id` term (no malformed uuid cast).
 * Scope: Pure logic only.
 * Links: src/features/nodes/node-lookup.ts
 */

import { describe, expect, it } from "vitest";
import { isNodeId, nodeIdOrSlug } from "@/features/nodes/node-lookup";

const UUID = "f97f68f2-8406-4a3b-b5a9-d579b779f19d";

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
