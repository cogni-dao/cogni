// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/node-app-scaffold/canonical-path-closure`
 * Purpose: Unit-prove TIER1_IS_CLOSED — a Tier-1 sync must deliver every script its canonical
 *   workflows invoke and every module its canonical contract barrels re-export. The regression under
 *   test is task.5078: forks received a `pr-build.yml` that ran `scripts/ci/*.mjs` and an `index.ts`
 *   that re-exported `./artifact-bundle.js`, neither of which the hand-listed set delivered, so the
 *   fork's build broke and no fork but the template could publish an Akash-consumable OCI bundle.
 * Scope: Pure (`deriveReferencedPaths`, `resolveCanonicalPathClosure`, `findUnsatisfiedReferences`);
 *   the reader is an in-memory map, no GitHub.
 * Links: src/shared/node-app-scaffold/canonical-path-closure.ts,
 *   src/app/_facades/deploy/canonical-fork-sync.server.ts, docs/spec/repo-sync-contract.md
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  type CanonicalClosureFile,
  deriveReferencedPaths,
  findUnsatisfiedReferences,
  resolveCanonicalPathClosure,
} from "@/shared/node-app-scaffold/canonical-path-closure";

/**
 * A faithful miniature of node-template's real Tier-1 surface at the task.5078 revision: a build
 * workflow that shells out to four CI scripts, scripts that import the repo-spec BUILD OUTPUT, and a
 * barrel that re-exports the module the hand-listed set forgot.
 */
const SOURCE: Record<string, string> = {
  ".github/workflows/pr-build.yml": `name: PR Build
jobs:
  detect:
    steps:
      - run: node scripts/ci/detect-node-build-targets.mjs
  build:
    steps:
      - run: node scripts/ci/write-node-build-fragment.mjs
  manifest:
    steps:
      - run: pnpm --filter @cogni/repo-spec build
      - run: node scripts/ci/write-node-build-manifest.mjs
      - run: |
          oras push "$bundle_tag_ref" --artifact-type "$ARTIFACT_TYPE" bundle.json
          node "$GITHUB_WORKSPACE/scripts/ci/record-node-bundle-publication.mjs"
`,
  "scripts/ci/detect-node-build-targets.mjs": `import { readFileSync } from "node:fs";
import { extractNodeArtifactBuilds } from "../../packages/repo-spec/dist/index.js";
`,
  "scripts/ci/write-node-build-fragment.mjs": `import { writeFileSync } from "node:fs";\n`,
  "scripts/ci/write-node-build-manifest.mjs": `import { buildNodeArtifactBundle } from "../../packages/repo-spec/dist/index.js";
`,
  "scripts/ci/record-node-bundle-publication.mjs": `import { readFileSync } from "node:fs";\n`,
  "packages/repo-spec/src/index.ts": `export { extractNodeId } from "./accessors.js";
export { buildNodeArtifactBundle } from "./artifact-bundle.js";
export { parseRepoSpec } from "./parse.js";
export { repoSpecSchema } from "./schema.js";
`,
  "packages/repo-spec/src/accessors.ts": `import type { RepoSpec } from "./schema.js";\n`,
  "packages/repo-spec/src/artifact-bundle.ts": `import { z } from "zod";
import { extractNodeServices } from "./accessors.js";
import type { RepoSpec } from "./schema.js";
`,
  "packages/repo-spec/src/parse.ts": `import { parse } from "yaml";
import { repoSpecSchema } from "./schema.js";
`,
  "packages/repo-spec/src/schema.ts": `import { z } from "zod";\n`,
  "packages/repo-spec/src/testing.ts": `import { parseRepoSpec } from "./parse.js";\n`,
  "packages/repo-spec/package.json": `{ "name": "@cogni/repo-spec" }\n`,
  "packages/repo-spec/tsconfig.json": `{ "extends": "../../tsconfig.base.json" }\n`,
  "packages/repo-spec/tsup.config.ts": `export default { entry: ["src/index.ts", "src/testing.ts"] };\n`,
  // Tier-1b identity substrate: an app file whose `@/…` graph must NOT be walked.
  "app/src/features/layout/components/AppHeader.tsx": `import { Button } from "@/components/ui/button";
import { useBrand } from "../hooks/useBrand";
`,
};

const ROOTS = [
  ".github/workflows/pr-build.yml",
  "packages/repo-spec/src/index.ts",
  "app/src/features/layout/components/AppHeader.tsx",
];

function resolve(
  source: Record<string, string> = SOURCE,
  roots: readonly string[] = ROOTS
) {
  const onMissingRequired = vi.fn();
  return resolveCanonicalPathClosure({
    roots,
    read: async (path) => source[path] ?? null,
    onMissingRequired,
  }).then((files) => ({ files, onMissingRequired }));
}

describe("deriveReferencedPaths", () => {
  it("pulls every repo script a canonical workflow invokes, however it is quoted", () => {
    const refs = deriveReferencedPaths(
      ".github/workflows/pr-build.yml",
      SOURCE[".github/workflows/pr-build.yml"] as string
    );
    expect(refs.map((r) => r.path)).toEqual([
      "scripts/ci/detect-node-build-targets.mjs",
      "scripts/ci/write-node-build-fragment.mjs",
      "scripts/ci/write-node-build-manifest.mjs",
      // interpolated inside a shell string — still a real invocation
      "scripts/ci/record-node-bundle-publication.mjs",
    ]);
  });

  it("maps a CI script's dist import back to the tracked package source", () => {
    const refs = deriveReferencedPaths(
      "scripts/ci/write-node-build-manifest.mjs",
      SOURCE["scripts/ci/write-node-build-manifest.mjs"] as string
    );
    expect(refs).toEqual([
      { path: "packages/repo-spec/src/index.ts", requirement: "required" },
    ]);
  });

  it("treats a contract barrel's re-exports as required edges", () => {
    const refs = deriveReferencedPaths(
      "packages/repo-spec/src/index.ts",
      SOURCE["packages/repo-spec/src/index.ts"] as string
    );
    const required = refs
      .filter((r) => r.requirement === "required")
      .map((r) => r.path);
    expect(required).toEqual([
      "packages/repo-spec/src/accessors.ts",
      "packages/repo-spec/src/artifact-bundle.ts",
      "packages/repo-spec/src/parse.ts",
      "packages/repo-spec/src/schema.ts",
    ]);
    // The package build manifest rides along best-effort, never fail-closed.
    expect(
      refs.filter((r) => r.requirement === "optional").map((r) => r.path)
    ).toEqual([
      "packages/repo-spec/package.json",
      "packages/repo-spec/tsconfig.json",
      "packages/repo-spec/tsup.config.ts",
    ]);
  });

  it("never walks the app's import graph (CLOSURE_IS_BOUNDED)", () => {
    expect(
      deriveReferencedPaths(
        "app/src/features/layout/components/AppHeader.tsx",
        SOURCE["app/src/features/layout/components/AppHeader.tsx"] as string
      )
    ).toEqual([]);
  });

  it("ignores bare package specifiers", () => {
    expect(
      deriveReferencedPaths(
        "packages/repo-spec/src/schema.ts",
        SOURCE["packages/repo-spec/src/schema.ts"] as string
      ).map((r) => r.path)
    ).not.toContain("zod");
  });
});

describe("resolveCanonicalPathClosure", () => {
  it("delivers the scripts + modules the hand-listed roots omitted (task.5078)", async () => {
    const { files, onMissingRequired } = await resolve();
    const delivered = files.map((f) => f.path);

    expect(onMissingRequired).not.toHaveBeenCalled();
    // The two files whose absence broke every fork's build.
    expect(delivered).toContain(
      "scripts/ci/record-node-bundle-publication.mjs"
    );
    expect(delivered).toContain("packages/repo-spec/src/artifact-bundle.ts");
    // …and the rest of the closure they imply.
    expect(delivered).toEqual(
      expect.arrayContaining([
        "scripts/ci/detect-node-build-targets.mjs",
        "scripts/ci/write-node-build-fragment.mjs",
        "scripts/ci/write-node-build-manifest.mjs",
        "packages/repo-spec/src/accessors.ts",
        "packages/repo-spec/src/parse.ts",
        "packages/repo-spec/src/schema.ts",
        "packages/repo-spec/src/testing.ts",
        "packages/repo-spec/package.json",
        "packages/repo-spec/tsup.config.ts",
      ])
    );
    // Roots stay first, in declaration order — the PR body reads like the contract.
    expect(delivered.slice(0, ROOTS.length)).toEqual(ROOTS);
    // Every path is read exactly once.
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("is a fixpoint: re-running over the delivered set adds nothing", async () => {
    const { files } = await resolve();
    expect(findUnsatisfiedReferences(files)).toEqual([]);
  });

  it("does not drag the app tree into the force-overwrite tier", async () => {
    const { files } = await resolve();
    const appPaths = files
      .map((f) => f.path)
      .filter((p) => p.startsWith("app/"));
    expect(appPaths).toEqual([
      "app/src/features/layout/components/AppHeader.tsx",
    ]);
  });

  it("fails closed when a re-exported module is absent at the source", async () => {
    const broken = { ...SOURCE };
    delete broken["packages/repo-spec/src/artifact-bundle.ts"];
    const { onMissingRequired } = await resolve(broken);
    expect(onMissingRequired).toHaveBeenCalledWith(
      "packages/repo-spec/src/artifact-bundle.ts"
    );
  });

  it("does not fail on a heuristic workflow reference that has no file", async () => {
    const source = {
      ...SOURCE,
      ".github/workflows/pr-build.yml": `${SOURCE[".github/workflows/pr-build.yml"]}
      # see scripts/ci/not-a-real-file.mjs for background
`,
    };
    const { files, onMissingRequired } = await resolve(source);
    expect(onMissingRequired).not.toHaveBeenCalled();
    expect(files.map((f) => f.path)).not.toContain(
      "scripts/ci/not-a-real-file.mjs"
    );
  });

  it("still fails closed when a heuristic path is later a real module edge", async () => {
    const source = {
      ...SOURCE,
      // Discovered first (optionally) from the workflow, then required by a script import.
      "scripts/ci/write-node-build-fragment.mjs": `import { x } from "./shared-helper.mjs";\n`,
      ".github/workflows/pr-build.yml": `${SOURCE[".github/workflows/pr-build.yml"]}
      - run: node scripts/ci/shared-helper.mjs
`,
    };
    const { onMissingRequired } = await resolve(source);
    expect(onMissingRequired).toHaveBeenCalledWith(
      "scripts/ci/shared-helper.mjs"
    );
  });

  it("reports a root that the source does not have", async () => {
    const { onMissingRequired } = await resolve(SOURCE, [
      ".github/workflows/gone.yaml",
    ]);
    expect(onMissingRequired).toHaveBeenCalledWith(
      ".github/workflows/gone.yaml"
    );
  });
});

describe("findUnsatisfiedReferences", () => {
  it("flags exactly the task.5078 gap for the OLD hand-listed Tier-1 set", () => {
    // Reconstruct what the hand-maintained list actually shipped: the workflow + the barrel + the
    // barrel's hand-listed siblings, and nothing else. This assertion is the regression guard — any
    // future hand-listed set that forgets an invoked script or a re-exported module fails here.
    const handListed: CanonicalClosureFile[] = [
      ".github/workflows/pr-build.yml",
      "packages/repo-spec/src/index.ts",
      "packages/repo-spec/src/accessors.ts",
      "packages/repo-spec/src/schema.ts",
    ].map((path) => ({ path, content: SOURCE[path] as string }));

    expect(findUnsatisfiedReferences(handListed)).toEqual([
      "packages/repo-spec/package.json",
      "packages/repo-spec/src/artifact-bundle.ts",
      "packages/repo-spec/src/parse.ts",
      "packages/repo-spec/tsconfig.json",
      "packages/repo-spec/tsup.config.ts",
      "scripts/ci/detect-node-build-targets.mjs",
      "scripts/ci/record-node-bundle-publication.mjs",
      "scripts/ci/write-node-build-fragment.mjs",
      "scripts/ci/write-node-build-manifest.mjs",
    ]);
  });

  it("is empty for the closure's own output", async () => {
    const { files } = await resolve();
    expect(findUnsatisfiedReferences(files)).toEqual([]);
  });
});
