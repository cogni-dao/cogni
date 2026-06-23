// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/sha-artifact-identity`
 * Purpose: Pins SOURCE_SHA_IS_DEPLOY_IDENTITY for the operator's own app artifact — every in-repo deployable is built, published, and resolved as `<image>:sha-<sourceSha>`, never the legacy `pr-{N}-{X}` / `mq-{N}-{Y}` / `preview-{sha}` namespaces (node-ci-cd-contract.md invariants 6 & 9; legacy-cicd-to-remove.md), so a regression cannot re-introduce the purged split-brain or drop the self-build triggers.
 * Scope: Static text assertions over the CI workflow source; does not shell out, build, deploy, or hit the network.
 * Invariants:
 *   PR_BUILD_SELF_BUILDS_ON_PUSH_MAIN: pr-build.yml triggers on pull_request +
 *     merge_group + push:[main] (push:main is the #1792 undeployable-main fix; the
 *     merge queue stays as the merge gate).
 *   PR_BUILD_TAGS_SHA: pr-build.yml emits image_tag=sha-<sourceSha>, never pr-/mq-.
 *   NO_LEGACY_IMAGE_TAG_IDENTITY: no flight/promote workflow constructs a pr-/mq-/
 *     preview- IMAGE tag for an in-repo artifact.
 * Side-effects: IO (reads .github/workflows/*.yml)
 * Links: .github/workflows/{pr-build,flight-preview,candidate-flight,promote-and-deploy}.yml,
 *        docs/spec/node-ci-cd-contract.md, docs/spec/legacy-cicd-to-remove.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WF = (name: string): string =>
  readFileSync(path.join(REPO_ROOT, ".github/workflows", name), "utf8");

describe("sha- artifact identity (SOURCE_SHA_IS_DEPLOY_IDENTITY)", () => {
  it("pr-build.yml self-builds on pull_request + merge_group + push:main", () => {
    const yml = WF("pr-build.yml");
    expect(yml).toMatch(/^\s*pull_request:/m);
    expect(yml).toMatch(/^\s*merge_group:/m);
    // push:main is the self-deploy build (the #1792 fix); the queue stays.
    expect(yml).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it("pr-build.yml tags sha-<sourceSha>, never pr-{N}/mq-{N}", () => {
    const yml = WF("pr-build.yml");
    expect(yml).toMatch(/IMAGE_TAG="sha-\$\{SOURCE_SHA\}"/);
    expect(yml).not.toMatch(/IMAGE_TAG="(pr|mq)-/);
  });

  it("no flight/promote workflow constructs a legacy pr-/mq-/preview- image tag", () => {
    for (const name of [
      "candidate-flight.yml",
      "flight-preview.yml",
      "promote-and-deploy.yml",
    ]) {
      const yml = WF(name);
      // The image tag is always sha-<sourceSha>. (Allowed: `deploy/preview-<node>`
      // BRANCH refs, `pr-build-*` concurrency keys — neither is an image tag.)
      expect(yml, `${name}: legacy IMAGE_TAG=`).not.toMatch(
        /IMAGE_TAG="(pr|mq|preview)-/
      );
      expect(yml, `${name}: legacy preview- image-tag base`).not.toMatch(
        /"preview-\$\{HEAD_SHA\}"/
      );
      expect(yml, `${name}: legacy mq- image_tag output`).not.toMatch(
        /image_tag=mq-/
      );
    }
  });

  it("flight-preview.yml resolves sha-<mainSha> directly (no re-tag to preview-)", () => {
    const yml = WF("flight-preview.yml");
    expect(yml).toMatch(/image_tag=sha-\$\{HEAD_SHA\}/);
    // The mq-→preview- re-tag step is purged.
    expect(yml).not.toContain("PREVIEW_TAG=");
    expect(yml).not.toMatch(/Re-tag merge_group images/);
  });
});
