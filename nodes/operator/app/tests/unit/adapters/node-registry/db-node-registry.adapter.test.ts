// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/db-node-registry.adapter`
 * Purpose: Unit tests for the DB-projection NodeRegistryPort adapter.
 * Scope: Verifies slug → NodeSummary mapping (title-case, derived href, placeholder thumbnail) and
 *   graceful [] on reader failure. The injected reader isolates the drizzle query.
 * Side-effects: none
 * Links: src/adapters/server/node-registry/db-node-registry.adapter.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import { DbNodeRegistryAdapter } from "@/adapters/server/node-registry/db-node-registry.adapter";

describe("adapters/node-registry/db-node-registry.adapter", () => {
  it("maps active slugs → NodeSummary with title-case + derived href + no thumbnail", async () => {
    const adapter = new DbNodeRegistryAdapter({
      listListedSlugs: async () => ["chaos", "node-template"],
      domain: "test.cognidao.org",
    });
    expect(await adapter.listPublic()).toEqual([
      {
        slug: "chaos",
        title: "Chaos",
        tagline: "",
        kind: "full-app",
        href: "https://chaos-test.cognidao.org",
      },
      {
        slug: "node-template",
        title: "Node Template",
        tagline: "",
        kind: "full-app",
        href: "https://node-template-test.cognidao.org",
      },
    ]);
  });

  it("degrades to [] when the reader throws (homepage never breaks)", async () => {
    const adapter = new DbNodeRegistryAdapter({
      listListedSlugs: async () => {
        throw new Error("db down");
      },
      domain: "test.cognidao.org",
    });
    expect(await adapter.listPublic()).toEqual([]);
  });
});
