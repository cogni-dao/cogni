// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/db-node-registry.adapter`
 * Purpose: Unit tests for the DB-projection NodeRegistryPort adapter.
 * Scope: Verifies DB row → NodeSummary mapping (title-case, repo identity, derived href,
 *   placeholder thumbnail) and graceful [] on reader failure. The injected reader isolates
 *   the drizzle query.
 * Side-effects: none
 * Links: src/adapters/server/node-registry/db-node-registry.adapter.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import { DbNodeRegistryAdapter } from "@/adapters/server/node-registry/db-node-registry.adapter";

describe("adapters/node-registry/db-node-registry.adapter", () => {
  it("maps active rows → NodeSummary with title-case + repo identity + derived href + no thumbnail", async () => {
    const adapter = new DbNodeRegistryAdapter({
      listListedNodes: async () => [
        {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "chaos",
          repoOwner: "Cogni-DAO",
          repoName: "chaos",
          repoUrl: "https://github.com/Cogni-DAO/chaos",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          slug: "node-template",
          repoOwner: "Cogni-DAO",
          repoName: "node-template",
          repoUrl: "https://github.com/Cogni-DAO/node-template",
        },
      ],
      domain: "test.cognidao.org",
    });
    expect(await adapter.listPublic()).toEqual([
      {
        slug: "chaos",
        nodeId: "11111111-1111-4111-8111-111111111111",
        title: "Chaos",
        tagline: "",
        kind: "full-app",
        repo: {
          owner: "Cogni-DAO",
          name: "chaos",
          url: "https://github.com/Cogni-DAO/chaos",
        },
        href: "https://chaos-test.cognidao.org",
      },
      {
        slug: "node-template",
        nodeId: "22222222-2222-4222-8222-222222222222",
        title: "Node Template",
        tagline: "",
        kind: "full-app",
        repo: {
          owner: "Cogni-DAO",
          name: "node-template",
          url: "https://github.com/Cogni-DAO/node-template",
        },
        href: "https://node-template-test.cognidao.org",
      },
    ]);
  });

  it("degrades to [] when the reader throws (homepage never breaks)", async () => {
    const adapter = new DbNodeRegistryAdapter({
      listListedNodes: async () => {
        throw new Error("db down");
      },
      domain: "test.cognidao.org",
    });
    expect(await adapter.listPublic()).toEqual([]);
  });
});
