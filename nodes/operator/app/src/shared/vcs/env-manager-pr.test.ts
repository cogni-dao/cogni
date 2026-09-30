// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/vcs/env-manager-pr.test`
 * Purpose: Unit-prove the pure env-manager PR classifier — the App-signature anti-spoof and the
 *   branch/trailer gates that let an env_manager merge its OWN signed env PR (task.5141).
 * Scope: `classifyEnvManagerCommit` over fabricated commit facts. No IO.
 * Links: nodes/operator/app/src/shared/vcs/env-manager-pr.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  classifyEnvManagerCommit,
  type EnvManagerCommitFacts,
} from "./env-manager-pr";

/** Build a commit message exactly as `envManagerCommitMessage` does (subject + trailers). */
function envMessage(opts: {
  node: string;
  env?: string;
  action?: string;
  changeType?: string;
}): string {
  const {
    node,
    env = "candidate-a",
    action = "add",
    changeType = "cogni.env-manager.v1",
  } = opts;
  return [
    `feat(node): ${action} ${node} to ${env}`,
    "",
    `Cogni-Change-Type: ${changeType}`,
    `Cogni-Node: ${node}`,
    `Cogni-Environment: ${env}`,
    `Cogni-Action: ${action}`,
    `Cogni-Changed-Paths-SHA256: ${"a".repeat(64)}`,
  ].join("\n");
}

const BOT_LOGIN = "cogni-operator[bot]";
const BOT_ID = 265189974;
const MONOREPO = "cogni-dao/cogni";

/** A fully valid, App-signed, operator-bot-authored env-membership commit for node `spawny-boi`. */
function signedFacts(
  overrides: Partial<EnvManagerCommitFacts> = {}
): EnvManagerCommitFacts {
  return {
    headRef: "cogni-operator/node-env-spawny-boi-candidate-a",
    commitMessage: envMessage({ node: "spawny-boi" }),
    verified: true,
    verificationReason: "valid",
    parentCount: 1,
    prState: "open",
    baseRef: "main",
    prUserLogin: BOT_LOGIN,
    prUserId: BOT_ID,
    prUserType: "Bot",
    headRepoFullName: MONOREPO,
    commitCount: 1,
    commitAuthorLogin: BOT_LOGIN,
    commitAuthorId: BOT_ID,
    expectedBotLogin: BOT_LOGIN,
    expectedBotId: BOT_ID,
    expectedHeadRepoFullName: MONOREPO,
    ...overrides,
  };
}

describe("classifyEnvManagerCommit", () => {
  it("accepts a properly App-signed env-membership PR and returns the target node", () => {
    expect(classifyEnvManagerCommit(signedFacts())).toEqual({
      isEnvManagerPr: true,
      targetNodeRef: "spawny-boi",
    });
  });

  it("accepts each env in the reserved branch family", () => {
    for (const env of ["candidate-a", "preview", "production"] as const) {
      const facts = signedFacts({
        headRef: `cogni-operator/node-env-spawny-boi-${env}`,
        commitMessage: envMessage({ node: "spawny-boi", env }),
      });
      expect(classifyEnvManagerCommit(facts).isEnvManagerPr).toBe(true);
    }
  });

  // --- Anti-spoof: the App signature is the line a human cannot forge. ---

  it("rejects an UNSIGNED (human) commit even with the right branch + trailers", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ verified: false })).isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a verified-but-not-'valid' reason (e.g. unverified/expired key)", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ verificationReason: "unsigned" }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a multi-parent (merge) commit — env PRs are single-parent", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ parentCount: 2 })).isEnvManagerPr
    ).toBe(false);
  });

  // --- Branch / trailer gates. ---

  it("rejects a branch outside the reserved family", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ headRef: "feature/whatever" }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("rejects when the branch slug and Cogni-Node trailer disagree", () => {
    expect(
      classifyEnvManagerCommit(
        signedFacts({
          headRef: "cogni-operator/node-env-other-node-candidate-a",
        })
      ).isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a missing Cogni-Change-Type trailer", () => {
    expect(
      classifyEnvManagerCommit(
        signedFacts({
          commitMessage: "feat(node): add spawny-boi to candidate-a",
        })
      ).isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a duplicated Cogni-Node trailer (ambiguous claim)", () => {
    const dup = `${envMessage({ node: "spawny-boi" })}\nCogni-Node: spawny-boi`;
    expect(
      classifyEnvManagerCommit(signedFacts({ commitMessage: dup }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a wrong change-type value", () => {
    expect(
      classifyEnvManagerCommit(
        signedFacts({
          commitMessage: envMessage({
            node: "spawny-boi",
            changeType: "cogni.something-else.v1",
          }),
        })
      ).isEnvManagerPr
    ).toBe(false);
  });

  // --- SoD identity gates: parity with classify-env-manager-fast-path.sh:170-192. A verified
  //     signature alone is NOT enough — a `node.manage_envs` holder could sign a look-alike commit
  //     with their own key on a fork PR. Only the exact operator bot, on the monorepo, may claim it.

  it("rejects a fork-head PR even when App-signed with the right branch + trailers", () => {
    expect(
      classifyEnvManagerCommit(
        signedFacts({ headRepoFullName: "attacker/cogni" })
      ).isEnvManagerPr
    ).toBe(false);
  });

  it("accepts a monorepo head whose full_name case differs (case-insensitive)", () => {
    expect(
      classifyEnvManagerCommit(
        signedFacts({ headRepoFullName: "Cogni-DAO/Cogni" })
      ).isEnvManagerPr
    ).toBe(true);
  });

  it("rejects a PR opened by a non-bot login", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ prUserLogin: "flock-leader" }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a PR opened by a look-alike login with the wrong user id", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ prUserId: 999999 })).isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a PR whose opener is not type Bot", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ prUserType: "User" }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a HEAD commit authored by a non-bot account (self-signed by a contributor)", () => {
    expect(
      classifyEnvManagerCommit(
        signedFacts({ commitAuthorLogin: "flock-leader", commitAuthorId: 42 })
      ).isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a HEAD commit whose author id mismatches the bot", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ commitAuthorId: 999999 }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a multi-commit PR (commits > 1)", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ commitCount: 2 })).isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a PR that is not open", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ prState: "closed" }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("rejects a PR based on a branch other than main", () => {
    expect(
      classifyEnvManagerCommit(signedFacts({ baseRef: "release" }))
        .isEnvManagerPr
    ).toBe(false);
  });

  it("fails closed when the adapter could not resolve a trusted bot id", () => {
    expect(
      classifyEnvManagerCommit(
        signedFacts({ expectedBotLogin: "", expectedBotId: Number.NaN })
      ).isEnvManagerPr
    ).toBe(false);
  });
});
