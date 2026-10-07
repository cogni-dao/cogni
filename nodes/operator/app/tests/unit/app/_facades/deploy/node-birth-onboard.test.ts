// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE_SHA = "6".repeat(40);
const MERGE_SHA = "7".repeat(40);
const classifyNodeRegisterPr = vi.fn(
  async (): Promise<{ isNodeRegisterPr: boolean; slug?: string }> => ({
    isNodeRegisterPr: true,
    slug: "red",
  })
);
const fetchFileText = vi.fn(async () =>
  [
    "name: red",
    "node_id: 11111111-1111-4111-8111-111111111111",
    `source_sha: ${SOURCE_SHA}`,
    "envs: [candidate-a, production]",
  ].join("\n")
);
const prepareNodeRefCandidateFlight = vi.fn(async () => ({
  nodeId: "11111111-1111-4111-8111-111111111111",
  slug: "red",
  sourceSha: SOURCE_SHA,
  sourceRepo: "https://github.com/cogni-dao/red",
  image: `ghcr.io/cogni-dao/red:sha-${SOURCE_SHA}`,
}));
const dispatchNodeBirthCandidateFlight = vi.fn(async () => ({
  status: "dispatched" as "dispatched" | "already_dispatched",
  workflowUrl:
    "https://github.com/Cogni-DAO/cogni/actions/workflows/candidate-flight.yml",
}));

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({
    classifyNodeRegisterPr,
    fetchFileText,
    prepareNodeRefCandidateFlight,
    dispatchNodeBirthCandidateFlight,
  }),
}));

import { dispatchNodeBirthOnboard } from "@/app/_facades/deploy/node-birth-onboard.server";

const ENV = {
  GH_REVIEW_APP_ID: "1",
  GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
  NODE_SUBMODULE_PARENT_OWNER: "Cogni-DAO",
  NODE_SUBMODULE_PARENT_REPO: "cogni",
  // biome-ignore lint/suspicious/noExplicitAny: facade uses this bounded env subset
} as any;
const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino test double
} as any;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "closed",
    repository: { name: "cogni", owner: { login: "Cogni-DAO" } },
    pull_request: {
      number: 2574,
      merged: true,
      merge_commit_sha: MERGE_SHA,
      head: { ref: "cogni-operator/node-register-red" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  classifyNodeRegisterPr.mockResolvedValue({
    isNodeRegisterPr: true,
    slug: "red",
  });
  dispatchNodeBirthCandidateFlight.mockResolvedValue({
    status: "dispatched",
    workflowUrl:
      "https://github.com/Cogni-DAO/cogni/actions/workflows/candidate-flight.yml",
  });
});

describe("dispatchNodeBirthOnboard", () => {
  it("dispatches the merged catalog source through the idempotent birth flight", async () => {
    await dispatchNodeBirthOnboard(payload(), ENV, log);

    expect(classifyNodeRegisterPr).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      prNumber: 2574,
    });
    expect(prepareNodeRefCandidateFlight).toHaveBeenCalledWith({
      parentOwner: "Cogni-DAO",
      parentRepo: "cogni",
      nodeId: "11111111-1111-4111-8111-111111111111",
      slug: "red",
      sourceSha: SOURCE_SHA,
    });
    expect(dispatchNodeBirthCandidateFlight).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      slug: "red",
      sourceSha: SOURCE_SHA,
      mergeSha: MERGE_SHA,
    });
  });

  it("does not dispatch a human-amended or spoofed birth", async () => {
    classifyNodeRegisterPr.mockResolvedValue({ isNodeRegisterPr: false });
    await dispatchNodeBirthOnboard(payload(), ENV, log);
    expect(fetchFileText).not.toHaveBeenCalled();
    expect(dispatchNodeBirthCandidateFlight).not.toHaveBeenCalled();
  });

  it("does not dispatch a look-alike branch from another repository", async () => {
    await dispatchNodeBirthOnboard(
      payload({
        repository: { name: "red", owner: { login: "Cogni-DAO" } },
      }),
      ENV,
      log
    );
    expect(classifyNodeRegisterPr).not.toHaveBeenCalled();
  });

  it("surfaces an invalid or absent candidate birth row", async () => {
    fetchFileText.mockResolvedValueOnce(
      `name: red\nsource_sha: ${SOURCE_SHA}\nenvs: [production]`
    );
    await expect(dispatchNodeBirthOnboard(payload(), ENV, log)).rejects.toThrow(
      "invalid merged birth catalog"
    );
    expect(dispatchNodeBirthCandidateFlight).not.toHaveBeenCalled();
  });

  it(
    "records duplicate redelivery as already dispatched without a second workflow",
    async () => {
      dispatchNodeBirthCandidateFlight.mockResolvedValueOnce({
        status: "already_dispatched",
        workflowUrl:
          "https://github.com/Cogni-DAO/cogni/actions/workflows/candidate-flight.yml",
      });
      await dispatchNodeBirthOnboard(payload(), ENV, log);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "already_dispatched" }),
        "feature.node_birth_onboard.complete"
      );
    }
  );

  it("fails loud when GitHub dispatch fails", async () => {
    dispatchNodeBirthCandidateFlight.mockRejectedValueOnce(
      Object.assign(new Error("GitHub unavailable"), { code: "dispatch_failed" })
    );
    await expect(dispatchNodeBirthOnboard(payload(), ENV, log)).rejects.toThrow(
      "GitHub unavailable"
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", errorCode: "dispatch_failed" }),
      "feature.node_birth_onboard.complete"
    );
  });
});
