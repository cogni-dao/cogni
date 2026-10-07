// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  classifyNodeRegisterCommit,
  type NodeRegisterCommitFacts,
} from "./node-register-pr";

const BOT_LOGIN = "cogni-operator[bot]";
const BOT_ID = 265189974;

function facts(
  overrides: Partial<NodeRegisterCommitFacts> = {}
): NodeRegisterCommitFacts {
  return {
    headRef: "cogni-operator/node-register-red",
    commitMessage: "feat(node): register red",
    verified: true,
    verificationReason: "valid",
    parentCount: 1,
    prState: "closed",
    merged: true,
    baseRef: "main",
    prUserLogin: BOT_LOGIN,
    prUserId: BOT_ID,
    prUserType: "Bot",
    headRepoFullName: "Cogni-DAO/cogni",
    commitCount: 1,
    commitAuthorLogin: BOT_LOGIN,
    commitAuthorId: BOT_ID,
    expectedBotLogin: BOT_LOGIN,
    expectedBotId: BOT_ID,
    expectedHeadRepoFullName: "cogni-dao/cogni",
    ...overrides,
  };
}

describe("classifyNodeRegisterCommit", () => {
  it("accepts the exact merged App-signed node-register operation", () => {
    expect(classifyNodeRegisterCommit(facts())).toEqual({
      isNodeRegisterPr: true,
      slug: "red",
    });
  });

  it.each([
    ["unsigned", { verified: false }],
    ["human opener", { prUserLogin: "flock-leader", prUserId: 1 }],
    ["human commit", { commitAuthorLogin: "flock-leader", commitAuthorId: 1 }],
    ["fork head", { headRepoFullName: "attacker/cogni" }],
    ["multiple commits", { commitCount: 2 }],
    ["unmerged", { merged: false }],
    ["wrong base", { baseRef: "release" }],
    ["branch/subject mismatch", { commitMessage: "feat(node): register blue" }],
  ])("rejects %s", (_label, overrides) => {
    expect(
      classifyNodeRegisterCommit(
        facts(overrides as Partial<NodeRegisterCommitFacts>)
      ).isNodeRegisterPr
    ).toBe(false);
  });
});
