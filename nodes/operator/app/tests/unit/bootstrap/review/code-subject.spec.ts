// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/review/code-subject.spec`
 * Purpose: Pin REVIEW_SUBJECT_IS_HOST_BOUND (story.5102) and SUBJECT_IS_SELF_OR_LISTED (task.5448): a run's code
 *   subject binds only for a catalog entry declaring it, only for this node or a listed link target, and only
 *   when owner/repo equal resolveNodeRepo(nodeId).
 * Scope: The pure decision; IO (catalog, node lookup, deploy plane) is covered by CI stack/flight.
 * Invariants: undeclared graph → 400; unlisted other node → 403; unknown node → 403; another repo → 403; match → bound.
 * Side-effects: none
 * Links: src/bootstrap/review/code-subject.ts, story.5102, task.5448
 * @internal
 */

import { describe, expect, it } from "vitest";
import { decideCodeSubject } from "@/bootstrap/review/code-subject";

const SELF = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const OTHER = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";

const subject = {
  nodeId: SELF,
  owner: "cogni-test-org",
  repo: "cogni-monorepo",
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
};
const self = { selfNodeId: SELF, subjectIsListed: false } as const;

describe("decideCodeSubject", () => {
  it("binds the node's own subject without any listing (the self case is unchanged)", () => {
    expect(
      decideCodeSubject({
        subject,
        catalogDeclares: true,
        resolvedRepo: { owner: "Cogni-Test-Org", repo: "cogni-monorepo" },
        ...self,
      })
    ).toEqual({ ok: true, codeSubject: subject });
  });

  it("binds a LISTED other node whose repo matches", () => {
    const other = { ...subject, nodeId: OTHER, repo: "node-template" };
    expect(
      decideCodeSubject({
        subject: other,
        catalogDeclares: true,
        resolvedRepo: { owner: "cogni-test-org", repo: "node-template" },
        selfNodeId: SELF,
        subjectIsListed: true,
      })
    ).toEqual({ ok: true, codeSubject: other });
  });

  it("refuses another node that is not listed", () => {
    expect(
      decideCodeSubject({
        subject: { ...subject, nodeId: OTHER },
        catalogDeclares: true,
        resolvedRepo: { owner: "cogni-test-org", repo: "cogni-monorepo" },
        selfNodeId: SELF,
        subjectIsListed: false,
      })
    ).toEqual({
      ok: false,
      status: 403,
      error: "code_subject_node_not_linked",
    });
  });

  it("refuses a repo other than the node's resolved repo", () => {
    expect(
      decideCodeSubject({
        subject: { ...subject, repo: "someone-elses-repo" },
        catalogDeclares: true,
        resolvedRepo: { owner: "cogni-test-org", repo: "cogni-monorepo" },
        ...self,
      })
    ).toEqual({ ok: false, status: 403, error: "code_subject_repo_mismatch" });
  });

  it("refuses an unknown node and a graph that does not declare codeSubject", () => {
    expect(
      decideCodeSubject({
        subject,
        catalogDeclares: true,
        resolvedRepo: null,
        ...self,
      })
    ).toEqual({ ok: false, status: 403, error: "code_subject_node_unknown" });
    expect(
      decideCodeSubject({
        subject,
        catalogDeclares: false,
        resolvedRepo: { owner: "cogni-test-org", repo: "cogni-monorepo" },
        ...self,
      })
    ).toEqual({ ok: false, status: 400, error: "code_subject_not_accepted" });
  });
});
