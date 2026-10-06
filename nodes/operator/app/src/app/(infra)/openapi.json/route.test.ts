// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/openapi.json/route.test`
 * Purpose: Proves the machine-served OpenAPI document advertises work-item writes.
 * Scope: Static contract generation only. Does not execute route handlers or touch a database.
 * Invariants: WORK_ITEM_WRITES_DISCOVERABLE, both create and patch appear with their real HTTP methods and request schemas.
 * Side-effects: none
 * Links: story.5060, docs/guides/agent-api-validation.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /openapi.json", () => {
  it("advertises create and patch work-item operations", async () => {
    const response = GET();
    const document = (await response.json()) as {
      paths?: Record<string, Record<string, unknown>>;
    };

    expect(document.paths?.["/work/items"]?.post).toBeDefined();
    expect(document.paths?.["/work/items/{id}"]?.patch).toBeDefined();
  });
});
