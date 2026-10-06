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
  "Cogni-Lease-Generation: 0",
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
  childRepositoryApps: {
    "cogni-test-org": {
      botLogin: "cogni-operator-test[bot]",
      botId: 290565426,
    },
  },
  operations: {
    "env.membership": {
      enabledRepositories: [repository],
      verifier: "scripts/ci/verifiers/verify-operator-change.sh",
    },
    "env.placement": { enabledRepositories: [], verifier: "disabled" },
    "env.region": { enabledRepositories: [], verifier: "disabled" },
    "node.register": { enabledRepositories: [], verifier: "disabled" },
    "deployment.declare": {
      enabledRepositories: [],
      enabledChildOwners: [],
      verifier: "disabled",
    },
  },
};

function facts(
  overrides: Partial<OperatorChangeFacts> = {}
): OperatorChangeFacts {
  return {
    repository,
    repositoryNode: "cogni-monorepo",
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
      classifyOperatorChangeForMerge(facts({ operationReplayVerified: false }))
    ).toMatchObject({ eligible: false, reason: "operation-replay-failed" });
  });

  it("accepts only repo-spec-bound child identity for deployment classification", () => {
    const childRepository = "cogni-test-org/blue";
    const childPath = ".cogni/repo-spec.yaml";
    const childPathHash = createHash("sha256")
      .update(`${childPath}\n`)
      .digest("hex");
    const childMessage = [
      "feat(deploy): declare blue node deployment",
      "",
      "Cogni-Change-Type: cogni.operator-change.v1",
      "Cogni-Operation: deployment.declare",
      "Cogni-Node: blue",
      `Cogni-Base-SHA: ${baseSha}`,
      `Cogni-Changed-Paths-SHA256: ${childPathHash}`,
    ].join("\n");
    const input = facts({
      repository: childRepository,
      repositoryNode: "blue",
      pr: {
        ...facts().pr,
        headRef: "cogni-operator/declare-deployment-blue",
        headRepoFullName: childRepository,
      },
      commit: { ...facts().commit, message: childMessage },
      files: [
        { filename: childPath, previousFilename: null, status: "modified" },
      ],
    });
    expect(classifyOperatorChangeForMerge(input)).toMatchObject({
      eligible: false,
      reason: "operation-disabled",
    });
    const childEnabledRegistry: OperatorChangeRegistry = {
      ...registry,
      operations: {
        ...registry.operations,
        "deployment.declare": {
          ...registry.operations["deployment.declare"],
          enabledChildOwners: ["cogni-test-org"],
        },
      },
    };
    expect(
      classifyOperatorChangeForMerge({
        ...input,
        registry: childEnabledRegistry,
      })
    ).toMatchObject({ eligible: true, reason: "eligible" });
    expect(
      classifyOperatorChangeForMerge({
        ...input,
        registry: childEnabledRegistry,
        operationReplayVerified: false,
      })
    ).toMatchObject({ eligible: false, reason: "operation-replay-failed" });
    expect(
      classifyOperatorChangeForMerge({ ...input, repositoryNode: "not-blue" })
    ).toMatchObject({ eligible: false, reason: "untrusted-repository" });
    expect(
      classifyOperatorChangeForMerge({
        ...input,
        repository: "other-org/blue",
        pr: { ...input.pr, headRepoFullName: "other-org/blue" },
        registry: childEnabledRegistry,
      })
    ).toMatchObject({ eligible: false, reason: "untrusted-repository" });

    const wrongOperation = facts({
      repository: childRepository,
      repositoryNode: "blue",
      pr: { ...facts().pr, headRepoFullName: childRepository },
    });
    expect(classifyOperatorChangeForMerge(wrongOperation)).toMatchObject({
      eligible: false,
      reason: "untrusted-repository",
    });
  });
});
