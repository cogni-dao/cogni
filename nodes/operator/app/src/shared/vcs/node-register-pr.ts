// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Pure classifier for the operator App's merged node-registration PR.
 *
 * A branch name is only a routing hint. Birth automation is authorized only when
 * the closed PR and its single HEAD commit are both attributable to this
 * deployment's exact GitHub App bot, the commit has a valid GitHub signature,
 * and every operation-bound value agrees on the node slug.
 */

export const NODE_REGISTER_BRANCH =
  /^cogni-operator\/node-register-([a-z0-9][a-z0-9-]{0,62})$/;

export interface NodeRegisterCommitFacts {
  readonly headRef: string;
  readonly commitMessage: string;
  readonly verified: boolean;
  readonly verificationReason: string | null;
  readonly parentCount: number;
  readonly prState: string | null;
  readonly merged: boolean;
  readonly baseRef: string | null;
  readonly prUserLogin: string | null;
  readonly prUserId: number | null;
  readonly prUserType: string | null;
  readonly headRepoFullName: string | null;
  readonly commitCount: number;
  readonly commitAuthorLogin: string | null;
  readonly commitAuthorId: number | null;
  readonly expectedBotLogin: string;
  readonly expectedBotId: number;
  readonly expectedHeadRepoFullName: string;
}

export interface NodeRegisterPrClassification {
  readonly isNodeRegisterPr: boolean;
  readonly slug?: string;
}

export function classifyNodeRegisterCommit(
  facts: NodeRegisterCommitFacts
): NodeRegisterPrClassification {
  const match = NODE_REGISTER_BRANCH.exec(facts.headRef);
  const slug = match?.[1];
  if (!slug) return { isNodeRegisterPr: false };

  if (facts.commitMessage.trim() !== `feat(node): register ${slug}`) {
    return { isNodeRegisterPr: false };
  }
  if (
    facts.verified !== true ||
    facts.verificationReason !== "valid" ||
    facts.parentCount !== 1 ||
    facts.prState !== "closed" ||
    facts.merged !== true ||
    facts.baseRef !== "main" ||
    facts.commitCount !== 1
  ) {
    return { isNodeRegisterPr: false };
  }
  if (
    !Number.isInteger(facts.expectedBotId) ||
    facts.expectedBotLogin.length === 0 ||
    facts.prUserLogin !== facts.expectedBotLogin ||
    facts.prUserId !== facts.expectedBotId ||
    facts.prUserType !== "Bot" ||
    facts.headRepoFullName === null ||
    facts.headRepoFullName.toLowerCase() !==
      facts.expectedHeadRepoFullName.toLowerCase() ||
    facts.commitAuthorLogin !== facts.expectedBotLogin ||
    facts.commitAuthorId !== facts.expectedBotId
  ) {
    return { isNodeRegisterPr: false };
  }

  return { isNodeRegisterPr: true, slug };
}
