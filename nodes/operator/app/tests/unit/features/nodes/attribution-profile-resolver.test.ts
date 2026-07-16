// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/attribution-profile-resolver`
 * Purpose: Unit tests for the git-attribution webhook routing resolver with fully faked deps.
 * Scope: match, case-insensitivity, unregistered→null, per-node skip-on-failure, cache reuse.
 * Invariants: PROFILE_SKIP_NEVER_THROWS, ROUTE_BY_DECLARED_SOURCE_REFS.
 * Side-effects: none
 * Links: src/features/nodes/attribution-profile-resolver.ts
 * @public
 */

import { TEST_SCOPE_ID } from "@cogni/repo-spec/testing";
import { describe, expect, it, vi } from "vitest";

import {
  type AttributionProfileResolverDeps,
  createAttributionProfileResolver,
  type ResolvedNodeRepo,
  type RoutableNode,
} from "@/features/nodes/attribution-profile-resolver";

const PARENT_OWNER = "cogni-dao";
const PARENT_REPO = "cogni";

/**
 * A schema-valid repo-spec YAML declaring one github source-ref. This must satisfy the
 * FULL `parseRepoSpec` zod schema (`governance` is required; `scope_id` must be a real UUID),
 * because the resolver deliberately routes off `parseRepoSpec` → `extractLedgerConfig`
 * (REPO_SPEC_AUTHORITY / ROUTE_BY_DECLARED_SOURCE_REFS). A spec that fails full validation is
 * SKIPPED (PROFILE_SKIP_NEVER_THROWS) → the node never routes — exactly the shape a real,
 * gate-validated node repo-spec always has.
 */
function specWithRefs(refs: string[]): string {
  return [
    "node_id: 00000000-0000-4000-8000-000000000000",
    `scope_id: ${TEST_SCOPE_ID}`,
    "scope_key: test-key",
    "governance:",
    "  chain_id: '8453'",
    "activity_ledger:",
    "  epoch_length_days: 7",
    "  approvers: []",
    "  activity_sources:",
    "    github:",
    "      attribution_pipeline: github",
    `      source_refs:`,
    ...refs.map((r) => `        - ${r}`),
  ].join("\n");
}

interface FakeDepsOverrides {
  nodes?: RoutableNode[];
  repos?: Record<string, ResolvedNodeRepo>;
  specs?: Record<string, string | null>;
  resolveNodeRepo?: (slug: string) => Promise<ResolvedNodeRepo>;
  fetchRepoSpecText?: (input: {
    owner: string;
    repo: string;
    isInRepo: boolean;
    slug: string;
  }) => Promise<string | null>;
  now?: () => number;
}

const silentLog = {
  warn: () => {},
  info: () => {},
  error: () => {},
  child: () => silentLog,
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino stub for tests
} as any;

function makeDeps(o: FakeDepsOverrides): AttributionProfileResolverDeps {
  const repos = o.repos ?? {};
  const specs = o.specs ?? {};
  return {
    listRoutableNodes: async () => o.nodes ?? [],
    resolveNodeRepo:
      o.resolveNodeRepo ??
      (async (slug: string) => {
        const r = repos[slug];
        if (!r)
          throw Object.assign(new Error("no catalog"), {
            code: "catalog_missing",
          });
        return r;
      }),
    fetchRepoSpecText:
      o.fetchRepoSpecText ??
      (async ({ owner, repo }) => {
        const key = `${owner}/${repo}`;
        return key in specs ? specs[key] : null;
      }),
    parentOwner: PARENT_OWNER,
    parentRepo: PARENT_REPO,
    now: o.now,
    log: silentLog,
  };
}

describe("createAttributionProfileResolver", () => {
  it("routes a declared repo to its owning node", async () => {
    const resolver = createAttributionProfileResolver(
      makeDeps({
        nodes: [{ id: "node-a", slug: "blue" }],
        repos: { blue: { owner: "someone", repo: "blue" } },
        specs: { "someone/blue": specWithRefs(["someone/blue"]) },
      })
    );

    expect(await resolver.resolveNodeForRepo("someone/blue")).toBe("node-a");
  });

  it("matches case-insensitively", async () => {
    const resolver = createAttributionProfileResolver(
      makeDeps({
        nodes: [{ id: "node-a", slug: "blue" }],
        repos: { blue: { owner: "Someone", repo: "Blue" } },
        specs: { "Someone/Blue": specWithRefs(["Someone/Blue"]) },
      })
    );

    expect(await resolver.resolveNodeForRepo("someone/blue")).toBe("node-a");
    expect(await resolver.resolveNodeForRepo("SOMEONE/BLUE")).toBe("node-a");
  });

  it("returns null for an unregistered repo", async () => {
    const resolver = createAttributionProfileResolver(
      makeDeps({
        nodes: [{ id: "node-a", slug: "blue" }],
        repos: { blue: { owner: "someone", repo: "blue" } },
        specs: { "someone/blue": specWithRefs(["someone/blue"]) },
      })
    );

    expect(await resolver.resolveNodeForRepo("other/repo")).toBeNull();
  });

  it("skips a node that throws (catalog_missing) and still indexes the others", async () => {
    const resolveNodeRepo = vi.fn(async (slug: string) => {
      if (slug === "prepublish") {
        throw Object.assign(new Error("no catalog"), {
          code: "catalog_missing",
        });
      }
      return { owner: "someone", repo: "blue" };
    });

    const resolver = createAttributionProfileResolver(
      makeDeps({
        nodes: [
          { id: "node-bad", slug: "prepublish" },
          { id: "node-a", slug: "blue" },
        ],
        specs: { "someone/blue": specWithRefs(["someone/blue"]) },
        resolveNodeRepo,
      })
    );

    // The throwing node is skipped; the healthy node still routes.
    expect(await resolver.resolveNodeForRepo("someone/blue")).toBe("node-a");
    expect(resolveNodeRepo).toHaveBeenCalledTimes(2);
  });

  it("returns null (fallback) when listRoutableNodes fails entirely", async () => {
    const resolver = createAttributionProfileResolver(
      makeDeps({
        resolveNodeRepo: async () => ({ owner: "x", repo: "y" }),
      })
    );
    // Override listRoutableNodes to throw.
    const deps = makeDeps({});
    const failing = createAttributionProfileResolver({
      ...deps,
      listRoutableNodes: async () => {
        throw new Error("db down");
      },
    });
    expect(await failing.resolveNodeForRepo("any/repo")).toBeNull();
    expect(await resolver.resolveNodeForRepo("any/repo")).toBeNull();
  });

  it("reuses the cached index within the TTL (single build)", async () => {
    let clock = 1_000;
    const listRoutableNodes = vi.fn(async () => [
      { id: "node-a", slug: "blue" },
    ]);
    const resolver = createAttributionProfileResolver({
      listRoutableNodes,
      resolveNodeRepo: async () => ({ owner: "someone", repo: "blue" }),
      fetchRepoSpecText: async () => specWithRefs(["someone/blue"]),
      parentOwner: PARENT_OWNER,
      parentRepo: PARENT_REPO,
      now: () => clock,
      ttlMs: 60_000,
      log: silentLog,
    });

    await resolver.resolveNodeForRepo("someone/blue");
    await resolver.resolveNodeForRepo("someone/blue");
    clock += 30_000; // still inside TTL
    await resolver.resolveNodeForRepo("someone/blue");
    expect(listRoutableNodes).toHaveBeenCalledTimes(1);

    clock += 40_000; // now stale → one rebuild
    await resolver.resolveNodeForRepo("someone/blue");
    expect(listRoutableNodes).toHaveBeenCalledTimes(2);
  });

  it("treats an in-repo node (repo == parent monorepo) as in-repo path", async () => {
    const fetchRepoSpecText = vi.fn(
      async (input: {
        owner: string;
        repo: string;
        isInRepo: boolean;
        slug: string;
      }) => {
        expect(input.isInRepo).toBe(true);
        return specWithRefs(["cogni-dao/cogni"]);
      }
    );
    const resolver = createAttributionProfileResolver(
      makeDeps({
        nodes: [{ id: "operator", slug: "operator" }],
        repos: { operator: { owner: PARENT_OWNER, repo: PARENT_REPO } },
        fetchRepoSpecText,
      })
    );

    expect(await resolver.resolveNodeForRepo("cogni-dao/cogni")).toBe(
      "operator"
    );
    expect(fetchRepoSpecText).toHaveBeenCalledWith({
      owner: PARENT_OWNER,
      repo: PARENT_REPO,
      isInRepo: true,
      slug: "operator",
    });
  });
});
