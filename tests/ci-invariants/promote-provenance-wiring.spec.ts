// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/promote-provenance-wiring`
 * Purpose: Pins how the promote workflow feeds source provenance into `resolve_remote_source_sha`. bug.5195 defect #2 was WIRING, not the resolver: the raw `inputs.source_sha` is empty on the product-contract promote, so it read as ABSENT authority.
 * Scope: Static YAML read of one workflow file. Does NOT contact a cluster, dispatch a run, or re-test the resolver itself.
 * Invariants:
 *   - AUTHORITY_IS_THE_RESOLVED_HEAD: every consumer gets `decide.outputs.head_sha`.
 *     `decide` sets head_sha = source_sha ?: github.sha and `app-src` is checked out AT
 *     head_sha, so that commit IS the one whose catalog source_sha was read. An explicit
 *     sourceSha resolves identically, because then head_sha == inputs.source_sha.
 *   - EVERY_CONSUMER_AGREES: the digest job and node-substrate must resolve the SAME
 *     revision. Two different provenances is the bug.5043 split-brain that
 *     verify-buildsha cannot catch, because it self-confirms the pin it wrote.
 * Side-effects: IO (reads the workflow file)
 * Links: bug.5195, scripts/ci/lib/image-tags.sh (resolve_remote_source_sha),
 *   scripts/ci/tests/resolve-remote-source-sha.test.sh
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = path.resolve(
  __dirname,
  "../../.github/workflows/promote-and-deploy.yml"
);
const body = readFileSync(WORKFLOW, "utf8");

describe("promote provenance wiring (bug.5195 defect #2)", () => {
  it("feeds OPERATOR_SOURCE_SHA from the resolved head at every consumer", () => {
    const assignments = [
      ...body.matchAll(/^\s*OPERATOR_SOURCE_SHA:\s*(.+)$/gm),
    ].map((m) => m[1].trim());

    expect(
      assignments.length,
      "expected the digest job and node-substrate to both state provenance"
    ).toBeGreaterThanOrEqual(2);

    for (const value of assignments) {
      expect(value).toBe("${{ needs.decide.outputs.head_sha }}");
    }
  });

  it("never reverts to the raw dispatch input, which reads as absent authority", () => {
    // `inputs.source_sha` is empty on the product-contract promote. Handing it to the
    // resolver is indistinguishable from "no authority at all", and the resolver then
    // correctly fails closed — refusing a promote that was entirely well-formed.
    expect(body).not.toMatch(/^\s*OPERATOR_SOURCE_SHA:\s*\$\{\{\s*inputs\.source_sha/m);
  });

  it("keeps head_sha defined so provenance can never be empty", () => {
    // decide: RAW_SOURCE_SHA=inputs.source_sha, then SHA="${RAW_SOURCE_SHA:-github.sha}".
    expect(body).toContain('SHA="${RAW_SOURCE_SHA:-${{ github.sha }}}"');
    expect(body).toContain("head_sha=$SHA");
  });
});
