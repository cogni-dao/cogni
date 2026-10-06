// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyOperatorChangeForMerge,
  type OperatorChangeFacts,
  type OperatorChangeRegistry,
} from "./operator-change-policy";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const repository = "cogni-test-org/cogni-monorepo";
const path = "infra/catalog/spawny-boi.yaml";
const pathHash = createHash("sha256").update(`${path}\n`).digest("hex");
const message = [
  "feat(node): add spawny-boi to candidate-a",
  "",
  "Cogni-Change-Type: cogni.operator-change.v1",
  "Cogni-Operation: env.membership",
  "Cogni-Node: spawny-boi",
  `Cogni-Base-SHA: ${baseSha}`,
  "Cogni-Environment: candidate-a",
  "Cogni-Action: add",
  `Cogni-Changed-Paths-SHA256: ${pathHash}`,
].join("\n");

const registry: OperatorChangeRegistry = {
  version: "cogni.operator-change.v1",
  repositories: {
    [repository]: {
      botLogin: "cogni-operator-test[bot]",
      botId: 290565426,
    },
  },
  operations: {
    "env.membership": {
      enabledRepositories: [repository],
      verifier: "scripts/ci/verifiers/verify-env-membership.sh",
    },
    "env.placement": { enabledRepositories: [], verifier: "disabled" },
    "env.region": { enabledRepositories: [], verifier: "disabled" },
    "node.register": { enabledRepositories: [], verifier: "disabled" },
    "deployment.declare": { enabledRepositories: [], verifier: "disabled" },
  },
};

function facts(
  overrides: Partial<OperatorChangeFacts> = {}
): OperatorChangeFacts {
  return {
    repository,
    expectedHeadSha: headSha,
    pr: {
      state: "open",
      baseRef: "main",
      baseSha,
      headRef: "cogni-operator/node-env-spawny-boi-candidate-a",
      headSha,
      headRepoFullName: repository,
      commitCount: 1,
      userLogin: "cogni-operator-test[bot]",
      userId: 290565426,
      userType: "Bot",
    },
    commit: {
      sha: headSha,
      message,
      verified: true,
      verificationReason: "valid",
      authorLogin: "cogni-operator-test[bot]",
      authorId: 290565426,
      parents: [baseSha],
    },
    files: [{ filename: path, previousFilename: null, status: "modified" }],
    registry,
    operationReplayVerified: true,
    ...overrides,
  };
}

describe("classifyOperatorChangeForMerge", () => {
  it("accepts only a fully replayed App-signed operation", () => {
    expect(classifyOperatorChangeForMerge(facts()).eligible).toBe(true);
  });

  it("rejects a human PR even if a forged ready check woke the handler", () => {
    const input = facts({
      pr: {
        ...facts().pr,
        userLogin: "human-author",
        userId: 42,
        userType: "User",
      },
    });
    expect(classifyOperatorChangeForMerge(input)).toMatchObject({
      eligible: false,
      reason: "invalid-pr-identity",
    });
  });

  it("rejects an operation before its exact repository is enabled", () => {
    const disabledRegistry: OperatorChangeRegistry = {
      ...registry,
      operations: {
        ...registry.operations,
        "env.membership": {
          ...registry.operations["env.membership"],
          enabledRepositories: [],
        },
      },
    };
    expect(
      classifyOperatorChangeForMerge(facts({ registry: disabledRegistry }))
    ).toMatchObject({ eligible: false, reason: "operation-disabled" });
  });

  it("rejects when operator-side operation replay does not match", () => {
    expect(
      classifyOperatorChangeForMerge(
        facts({ operationReplayVerified: false })
      )
    ).toMatchObject({ eligible: false, reason: "operation-replay-failed" });
  });
});
