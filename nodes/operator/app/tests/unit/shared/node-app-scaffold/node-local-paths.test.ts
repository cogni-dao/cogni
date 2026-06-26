// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/node-app-scaffold/node-local-paths`
 * Purpose: Unit-prove the Tier-3 (node-local) declaration parser + matcher — the SSOT carve-out of
 *   node identity/presentation from the fork-sync substrate merge.
 * Scope: Pure (`parseNodeLocalPaths` + `makeNodeLocalMatcher`); no IO.
 * Links: src/shared/node-app-scaffold/node-local-paths.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NODE_LOCAL_PATHS,
  makeNodeLocalMatcher,
  parseNodeLocalPaths,
} from "@/shared/node-app-scaffold/node-local-paths";

describe("parseNodeLocalPaths", () => {
  it("returns the declared node_local block when present", () => {
    const yaml = `schema: 2
node_local:
  - "app/src/app/(public)/**"
  - ".cogni/repo-spec.yaml"
exclude:
  - ".git/**"
`;
    expect(parseNodeLocalPaths(yaml)).toEqual([
      "app/src/app/(public)/**",
      ".cogni/repo-spec.yaml",
    ]);
  });

  it("falls back to the default floor when the manifest has no node_local block", () => {
    const yaml = `schema: 2
exclude:
  - ".git/**"
`;
    expect(parseNodeLocalPaths(yaml)).toBe(DEFAULT_NODE_LOCAL_PATHS);
  });

  it("falls back to the default floor when node_local is empty", () => {
    expect(parseNodeLocalPaths("schema: 2\nnode_local: []\n")).toBe(
      DEFAULT_NODE_LOCAL_PATHS
    );
  });

  it("falls back to the default floor on missing / malformed input (fail-safe)", () => {
    expect(parseNodeLocalPaths(null)).toBe(DEFAULT_NODE_LOCAL_PATHS);
    expect(parseNodeLocalPaths(undefined)).toBe(DEFAULT_NODE_LOCAL_PATHS);
    expect(parseNodeLocalPaths(": : not : yaml : [")).toBe(
      DEFAULT_NODE_LOCAL_PATHS
    );
  });
});

describe("makeNodeLocalMatcher", () => {
  const matches = makeNodeLocalMatcher([
    "app/src/app/(public)/**",
    "app/src/features/home/**",
    ".cogni/repo-spec.yaml",
  ]);

  it("matches Tier-3 presentation + identity paths (deep + exact)", () => {
    expect(matches("app/src/app/(public)/page.tsx")).toBe(true);
    expect(matches("app/src/app/(public)/landing/hero/Hero.tsx")).toBe(true);
    expect(matches("app/src/features/home/components/Pitch.tsx")).toBe(true);
    expect(matches(".cogni/repo-spec.yaml")).toBe(true);
  });

  it("does NOT match Tier-2 substrate paths", () => {
    expect(matches("app/src/app/api/v1/cognition/_bundle.ts")).toBe(false);
    expect(matches("packages/knowledge-base/src/seeds/base.ts")).toBe(false);
    expect(matches("app/src/shared/env/server-env.ts")).toBe(false);
    expect(matches(".cogni/sync-manifest.yaml")).toBe(false);
    // A single `*` is one path segment — must not leak across `/`.
    expect(matches("app/src/features/home")).toBe(false);
  });
});

describe("DEFAULT_NODE_LOCAL_PATHS boundary — node owns its face, not the shell", () => {
  const matches = makeNodeLocalMatcher(DEFAULT_NODE_LOCAL_PATHS);

  it("keeps the node's homepage + home feature + branding/identity node-local", () => {
    expect(matches("app/src/app/(public)/page.tsx")).toBe(true);
    expect(matches("app/src/features/home/components/Pitch.tsx")).toBe(true);
    expect(matches(".cogni/repo-spec.yaml")).toBe(true);
  });

  it("does NOT strand generic (public) shell or platform routes — they must sync to track shared contracts", () => {
    // Regression guard: carving these out as node-local strands forks at stale
    // versions and breaks them against changed shared components (e.g. AppHeader's
    // brandMark prop). The node owns its homepage, NOT the app shell.
    expect(matches("app/src/app/(public)/layout.tsx")).toBe(false);
    expect(matches("app/src/app/(public)/error.tsx")).toBe(false);
    expect(matches("app/src/app/(public)/loading.tsx")).toBe(false);
    expect(matches("app/src/app/(public)/AuthRedirect.tsx")).toBe(false);
    expect(matches("app/src/app/(public)/propose/merge/page.tsx")).toBe(false);
  });
});
