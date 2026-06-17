// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/unit/adapters/server/vcs/catalog-fork-target`
 * Purpose: Unit-prove `catalogYamlToForkTarget` — the parent-catalog `source_repo` → fork-target parser
 *   that selects fork-sync targets (excludes node-template/operator + non-node rows).
 * Scope: Pure function, no IO.
 * Links: src/adapters/server/vcs/github-repo-write.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { catalogYamlToForkTarget } from "@/adapters/server/vcs/github-repo-write";

describe("catalogYamlToForkTarget", () => {
  it("maps a type:node row's source_repo to {owner,name,slug}", () => {
    const yaml =
      "name: test-cog\ntype: node\nsource_repo: https://github.com/cogni-test-org/test-cog.git\n";
    expect(catalogYamlToForkTarget("test-cog", yaml)).toEqual({
      owner: "cogni-test-org",
      name: "test-cog",
      slug: "test-cog",
    });
  });

  it("excludes the mirror source (node-template) and the hub (operator)", () => {
    const nt =
      "type: node\nsource_repo: https://github.com/cogni-test-org/node-template.git\n";
    expect(catalogYamlToForkTarget("node-template", nt)).toBeNull();
    expect(catalogYamlToForkTarget("operator", "type: node\n")).toBeNull();
  });

  it("ignores non-node rows (infra/service) and rows without source_repo", () => {
    expect(catalogYamlToForkTarget("litellm", "type: infra\n")).toBeNull();
    expect(
      catalogYamlToForkTarget("scheduler-worker", "type: service\n")
    ).toBeNull();
    expect(catalogYamlToForkTarget("blue", "type: node\n")).toBeNull();
  });

  it("returns null on malformed yaml / bad source_repo rather than throwing", () => {
    expect(catalogYamlToForkTarget("x", ": : not yaml :")).toBeNull();
    expect(
      catalogYamlToForkTarget("x", "type: node\nsource_repo: not-a-url\n")
    ).toBeNull();
  });
});
