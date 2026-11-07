// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/review/code-subject.spec`
 * Purpose: Pin REVIEW_SUBJECT_IS_HOST_BOUND (story.5102): a run's code subject binds only for a
 *   catalog entry declaring it and only when owner/repo equal resolveNodeRepo(nodeId).
 * Scope: The pure decision; IO (catalog, node lookup, deploy plane) is covered by CI stack/flight.
 * Invariants: undeclared graph → 400; unknown node → 403; another repo → 403; match → bound.
 * Side-effects: none
 * Links: src/bootstrap/review/code-subject.ts, story.5102
 * @internal
 */

import { describe, expect, it } from "vitest";
import { decideCodeSubject } from "@/bootstrap/review/code-subject";

const subject = {
  nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  owner: "cogni-test-org",
  repo: "cogni-monorepo",
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
};

describe("decideCodeSubject", () => {
  it("binds a subject whose repo matches the resolved node repo (case-insensitive)", () => {
    expect(
      decideCodeSubject({
        subject,
        catalogDeclares: true,
        resolvedRepo: { owner: "Cogni-Test-Org", repo: "cogni-monorepo" },
      })
    ).toEqual({ ok: true, codeSubject: subject });
  });

  it("refuses a repo other than the node's resolved repo", () => {
    expect(
      decideCodeSubject({
        subject: { ...subject, repo: "someone-elses-repo" },
        catalogDeclares: true,
        resolvedRepo: { owner: "cogni-test-org", repo: "cogni-monorepo" },
      })
    ).toEqual({ ok: false, status: 403, error: "code_subject_repo_mismatch" });
  });

  it("refuses an unknown node and a graph that does not declare codeSubject", () => {
    expect(
      decideCodeSubject({ subject, catalogDeclares: true, resolvedRepo: null })
    ).toEqual({ ok: false, status: 403, error: "code_subject_node_unknown" });
    expect(
      decideCodeSubject({
        subject,
        catalogDeclares: false,
        resolvedRepo: { owner: "cogni-test-org", repo: "cogni-monorepo" },
      })
    ).toEqual({ ok: false, status: 400, error: "code_subject_not_accepted" });
  });
});
