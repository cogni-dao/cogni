// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@tests/unit/app/_facades/deploy/lane-onboard`
 * Purpose: Exercise verified merged operations and both-own-pin preflight at existing dispatcher seams.
 * Scope: Mocked deploy-plane transport only. No runtime writes.
 * Invariants: VERIFIED_OPERATION, REPLAY_NEVER_ADVANCES, NO_EFFECT_BEFORE_BOTH_PINS, ONE_EVENT.
 * Side-effects: none
 * Links: subtask.5030, env-verb-activation R2
 * @internal
 */
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ServerEnv } from "@/shared/env";

const lanePin = "2".repeat(40),
  custodianPin = "1".repeat(40),
  birth = "3".repeat(40);
const headSha = "a".repeat(40),
  mergeSha = "b".repeat(40),
  parentSha = "c".repeat(40);
const nodeId = "f66b260b-a859-4399-888e-a8c7a6696f7e";
const promoteNode = vi.fn(async (_input: unknown) => ({
  runId: 99,
  workflowUrl: "https://github.com/x/y/actions",
}));
const prepareNodeRefCandidateFlight = vi.fn(
  async (input: { sourceSha: string }) => ({
    slug: "toks5",
    sourceSha: input.sourceSha,
  })
);
const dispatchNodeRefCandidateFlight = vi.fn(async (_input: unknown) => ({
  workflowUrl: "https://github.com/x/y/actions",
}));
const pruneNodeEnvironment = vi.fn(async (_input: unknown) => ({
  runId: 100,
  workflowUrl: "https://github.com/x/y/actions",
}));
const readNodeDeployPin = vi.fn(
  async (input: { env: string }): Promise<string | null> =>
    input.env === "production" ? custodianPin : lanePin
);
const readNodeDeployPinState = vi.fn(
  async (input: {
    env: string;
  }): Promise<
    { kind: "ok"; sha: string } | { kind: "missing" } | { kind: "invalid" }
  > => ({
    kind: "ok",
    sha: input.env === "production" ? custodianPin : lanePin,
  })
);
const catalog = (envs = "candidate-a, preview, production") =>
  `name: toks5\nnode_id: ${nodeId}\nsource_sha: "${birth}"\nenvs: [${envs}]\ndeployment_provider: {candidate-a: akash, preview: akash, production: akash}\nlease_generation: {candidate-a: 2, preview: 3, production: 6}\n`;
const fetchFileText = vi.fn(
  async (_input: unknown): Promise<string | null> => catalog()
);
let operation: Record<string, unknown>;
const classifyEnvManagerPr = vi.fn(async (_input: unknown) => operation);
vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({
    promoteNode,
    prepareNodeRefCandidateFlight,
    dispatchNodeRefCandidateFlight,
    pruneNodeEnvironment,
    readNodeDeployPin,
    readNodeDeployPinState,
    fetchFileText,
    classifyEnvManagerPr,
  }),
}));

import { dispatchLaneOnboard } from "@/app/_facades/deploy/lane-onboard.server";

const env = {
  GH_REVIEW_APP_ID: "123",
  GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
  NODE_SUBMODULE_PARENT_OWNER: "Cogni-DAO",
  NODE_SUBMODULE_PARENT_REPO: "cogni",
  FLEET_CONTROL_ENV: "production",
} as ServerEnv;
const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;
const payload = (lane = "candidate-a") => ({
  action: "closed",
  repository: { name: "cogni", owner: { login: "Cogni-DAO" } },
  pull_request: {
    number: 2360,
    merged: true,
    merge_commit_sha: mergeSha,
    head: { ref: `cogni-operator/node-env-toks5-${lane}`, sha: headSha },
    base: { sha: parentSha },
  },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function zeroEffects() {
  expect(promoteNode).not.toHaveBeenCalled();
  expect(prepareNodeRefCandidateFlight).not.toHaveBeenCalled();
  expect(dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
  expect(pruneNodeEnvironment).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  fetchFileText.mockImplementation(async () => catalog());
  readNodeDeployPin.mockImplementation(async (input) =>
    input.env === "production" ? custodianPin : lanePin
  );
  readNodeDeployPinState.mockImplementation(async (input) => ({
    kind: "ok",
    sha: input.env === "production" ? custodianPin : lanePin,
  }));
  promoteNode.mockImplementation(async () => ({
    runId: 99,
    workflowUrl: "https://github.com/x/y/actions",
  }));
  operation = {
    isEnvManagerPr: true,
    action: "repair",
    targetNodeRef: "toks5",
    environment: "candidate-a",
    headSha,
    parentSha,
    baseCatalog: catalog(),
    headCatalog: catalog(),
  };
});
describe("trusted merged identity", () => {
  it("carries exact repository, PR, event head and merge to scoped merged classifier", async () => {
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(classifyEnvManagerPr).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      prNumber: 2360,
      mergedOperation: {
        repository: "Cogni-DAO/cogni",
        prNumber: 2360,
        headSha,
        mergeSha,
      },
    });
    // MAIN qualifies present intent; it never substitutes for authenticated operation history.
    expect(fetchFileText).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      path: "infra/catalog/toks5.yaml",
      ref: "main",
    });
  });
  it.each([
    "repair_context_conflict",
    "repair_context_unavailable",
  ])("refuses forged/unreadable operation: %s", async (errorCode) => {
    operation = { isEnvManagerPr: false, errorCode };
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode, dispatched: 0 }),
      "feature.lane_onboard.complete"
    );
  });
  it("missing merge identity cannot dispatch", async () => {
    const event = payload();
    delete (event.pull_request as Partial<typeof event.pull_request>)
      .merge_commit_sha;
    dispatchLaneOnboard(event, env, log);
    await settle();
    zeroEffects();
  });
  it("ordinary branches and foreign repositories do nothing", async () => {
    const event = payload();
    event.pull_request.head.ref = "agent/ordinary";
    dispatchLaneOnboard(event, env, log);
    await settle();
    zeroEffects();
    expect(classifyEnvManagerPr).not.toHaveBeenCalled();
  });
});

describe("R22 current intent before effects", () => {
  for (const action of ["add", "repair"] as const) {
    for (const lane of ["candidate-a", "preview"] as const) {
      it(`${action} ${lane} delivery/redelivery after REMOVE is superseded despite both valid own pins`, async () => {
        operation.action = action;
        operation.environment = lane;
        if (action === "add")
          operation.baseCatalog = catalog(
            lane === "candidate-a"
              ? "preview, production"
              : "candidate-a, production"
          );
        fetchFileText.mockResolvedValue(
          catalog(
            lane === "candidate-a"
              ? "preview, production"
              : "candidate-a, production"
          )
        );
        for (let delivery = 0; delivery < 2; delivery++) {
          dispatchLaneOnboard(payload(lane), env, log);
          await settle();
          zeroEffects();
          expect(log.info).toHaveBeenCalledTimes(delivery + 1);
          expect(log.info).toHaveBeenLastCalledWith(
            expect.objectContaining({ outcome: "superseded", dispatched: 0 }),
            "feature.lane_onboard.complete"
          );
        }
        expect(log.error).not.toHaveBeenCalled();
      });
    }
    it.each([
      "missing",
      "unreadable",
      "foreign-node",
      "foreign-name",
      "malformed",
      "malformed-policy",
    ])(`${action} refuses %s current state with zero effects`, async (cause) => {
      operation.action = action;
      if (action === "add")
        operation.baseCatalog = catalog("preview, production");
      fetchFileText.mockImplementation(async () => {
        if (cause === "missing") return null;
        if (cause === "unreadable") throw new Error("GitHub unavailable");
        if (cause === "foreign-node")
          return catalog().replace(nodeId, "foreign-node");
        if (cause === "foreign-name")
          return catalog().replace("name: toks5", "name: other");
        if (cause === "malformed-policy")
          return catalog().replace(
            "lease_generation: {candidate-a: 2, preview: 3, production: 6}",
            "lease_generation: unreadable"
          );
        return "envs: [";
      });
      dispatchLaneOnboard(payload(), env, log);
      await settle();
      zeroEffects();
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: "repair_context_unavailable",
          dispatched: 0,
        }),
        "feature.lane_onboard.complete"
      );
    });
    it(`${action} remains valid after unrelated preview changes`, async () => {
      operation.action = action;
      if (action === "add")
        operation.baseCatalog = catalog("preview, production");
      const current = parseYaml(catalog());
      current.envs = ["candidate-a", "production"];
      current.lease_generation.preview = 99;
      current.deployment_provider.preview = "k3s";
      current.required_placement_countries = { preview: ["US"] };
      current.isolated_services = {
        worker: { lease_generation: { preview: 8 } },
      };
      current.compute_egress_cidrs = [
        { cidr: "192.0.2.1/32", envs: ["preview"], ports: [5432] },
      ];
      // An unrelated policy map can be added without fencing this lane/custodian pair.
      fetchFileText.mockResolvedValue(stringifyYaml(current));
      dispatchLaneOnboard(payload(), env, log);
      await settle();
      expect(promoteNode).toHaveBeenCalledWith(
        expect.objectContaining({ env: "production", sourceSha: custodianPin })
      );
      expect(dispatchNodeRefCandidateFlight).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSha: lanePin })
      );
      expect(log.error).not.toHaveBeenCalled();
    });
  }
  it.each([
    [
      "target generation",
      "lease_generation",
      { "candidate-a": 4, preview: 3, production: 6 },
    ],
    [
      "target placement",
      "deployment_provider",
      { "candidate-a": "k3s", preview: "akash", production: "akash" },
    ],
    ["target authority", "compute_api", { "candidate-a": "legacy" }],
    ["target boot policy", "boot_recovery", { "candidate-a": "auto" }],
    [
      "target placement policy",
      "required_placement_countries",
      { "candidate-a": ["US"] },
    ],
    [
      "target data binding",
      "database",
      { "candidate-a": { tier: "dedicated" } },
    ],
    [
      "custodian generation",
      "lease_generation",
      { "candidate-a": 2, preview: 3, production: 7 },
    ],
    ["source owner", "source_repo", "https://github.com/other/toks5.git"],
    [
      "node owner",
      "owner_wallet",
      "0x1111111111111111111111111111111111111111",
    ],
    ["activity owner", "activity_env", "preview"],
  ])("superseded %s refuses old repair before either replay", async (_name, key, value) => {
    const current = parseYaml(catalog());
    current[key as string] = value;
    fetchFileText.mockResolvedValue(stringifyYaml(current));
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "superseded", dispatched: 0 }),
      "feature.lane_onboard.complete"
    );
  });
  it("old ADD cannot replay a superseded target generation", async () => {
    operation.action = "add";
    operation.baseCatalog = catalog("preview, production");
    fetchFileText.mockResolvedValue(
      catalog().replace("candidate-a: 2", "candidate-a: 4")
    );
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "superseded", dispatched: 0 }),
      "feature.lane_onboard.complete"
    );
  });
  it("ADD during the historical REMOVE provider read prevents prune", async () => {
    operation.action = "remove";
    operation.headCatalog = catalog("preview, production");
    let reactivated = false;
    fetchFileText.mockImplementation(async (input) => {
      if ((input as { ref: string }).ref !== "main") {
        reactivated = true;
        return catalog();
      }
      return reactivated ? catalog() : String(operation.headCatalog);
    });
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "superseded", dispatched: 0 }),
      "feature.lane_onboard.complete"
    );
  });
  it("REMOVE during pin reads refuses before the first replay", async () => {
    readNodeDeployPin.mockImplementation(async (input) => {
      fetchFileText.mockResolvedValue(catalog("preview, production"));
      return input.env === "production" ? custodianPin : lanePin;
    });
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "superseded", dispatched: 0 }),
      "feature.lane_onboard.complete"
    );
  });
  it("supersession between replays preserves the completed custodian count", async () => {
    promoteNode.mockImplementation(async () => {
      fetchFileText.mockResolvedValue(catalog("preview, production"));
      return { runId: 99, workflowUrl: "https://github.com/x/y/actions" };
    });
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(promoteNode).toHaveBeenCalledTimes(1);
    expect(prepareNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "superseded",
        dispatched: 1,
        completed: [
          expect.objectContaining({
            env: "production",
            sourceSha: custodianPin,
            runId: 99,
          }),
        ],
      }),
      "feature.lane_onboard.complete"
    );
  });
  it("current state lost after candidate preparation refuses flight and retains completed replay", async () => {
    prepareNodeRefCandidateFlight.mockImplementationOnce(async (input) => {
      fetchFileText.mockResolvedValue(null);
      return { slug: "toks5", sourceSha: input.sourceSha };
    });
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatched: 1,
        errorCode: "repair_context_unavailable",
      }),
      "feature.lane_onboard.complete"
    );
  });
});
describe("R2 B1 both-own-pin falsifiers", () => {
  for (const failed of ["candidate-a", "production"]) {
    for (const cause of ["missing", "invalid", "unreadable"]) {
      it(`${failed} ${cause}: zero preparation, flight and promotion even with other pin valid`, async () => {
        readNodeDeployPin.mockImplementation(async (input) => {
          if (input.env !== failed)
            return input.env === "production" ? custodianPin : lanePin;
          if (cause === "unreadable") throw new Error("read failed");
          return cause === "missing" ? null : "invalid";
        });
        dispatchLaneOnboard(payload(), env, log);
        await settle();
        zeroEffects();
        expect(readNodeDeployPin).toHaveBeenCalledTimes(2);
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({
            errorCode: "repair_pin_unavailable",
            renderEnv: failed,
            dispatched: 0,
          }),
          "feature.lane_onboard.complete"
        );
      });
    }
  }
  it("pins lost after earlier successful qualification are read again at hook time", async () => {
    await readNodeDeployPin({ env: "candidate-a" });
    await readNodeDeployPin({ env: "production" });
    readNodeDeployPin.mockImplementation(async (input) =>
      input.env === "production" ? null : lanePin
    );
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(readNodeDeployPin).toHaveBeenCalledTimes(4);
  });
  it("valid distinct pins: custodian first, candidate prepare/flight at lane pin, never birth", async () => {
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(promoteNode).toHaveBeenCalledWith(
      expect.objectContaining({ env: "production", sourceSha: custodianPin })
    );
    expect(prepareNodeRefCandidateFlight).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId, sourceSha: lanePin })
    );
    expect(dispatchNodeRefCandidateFlight).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha: lanePin })
    );
    expect(readNodeDeployPin.mock.invocationCallOrder[1]).toBeLessThan(
      promoteNode.mock.invocationCallOrder[0] ?? 0
    );
    expect(promoteNode.mock.invocationCallOrder[0]).toBeLessThan(
      prepareNodeRefCandidateFlight.mock.invocationCallOrder[0] ?? 0
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatched: 2,
        laneSha8: lanePin.slice(0, 8),
        custodianSha8: custodianPin.slice(0, 8),
      }),
      "feature.lane_onboard.complete"
    );
  });
  it("preview uses its own pin and reports one completed run if later dispatch fails", async () => {
    operation.environment = "preview";
    promoteNode.mockImplementation(async (input) => {
      if ((input as { env: string }).env === "preview")
        throw Object.assign(new Error("failed"), { code: "dispatch_failed" });
      return { runId: 99, workflowUrl: "https://github.com/x/y/actions" };
    });
    dispatchLaneOnboard(payload("preview"), env, log);
    await settle();
    expect(promoteNode.mock.calls[1]?.[0]).toMatchObject({
      env: "preview",
      sourceSha: lanePin,
    });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatched: 1,
        errorCode: "dispatch_failed",
        completed: [
          expect.objectContaining({
            env: "production",
            sourceSha: custodianPin,
            runId: 99,
          }),
        ],
      }),
      "feature.lane_onboard.complete"
    );
  });
  it("candidate prepare failure retains the already completed custodian replay", async () => {
    prepareNodeRefCandidateFlight.mockRejectedValueOnce(
      Object.assign(new Error("preflight failed"), {
        code: "image_unavailable",
      })
    );
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatched: 1,
        errorCode: "image_unavailable",
        completed: [
          expect.objectContaining({
            env: "production",
            sourceSha: custodianPin,
            runId: 99,
          }),
        ],
      }),
      "feature.lane_onboard.complete"
    );
  });
  it("lane which is its own custodian reads and dispatches once", async () => {
    operation.environment = "production";
    dispatchLaneOnboard(payload("production"), env, log);
    await settle();
    expect(readNodeDeployPin).toHaveBeenCalledTimes(1);
    expect(promoteNode).toHaveBeenCalledTimes(1);
  });
});
describe("safe first activation and removal controls", () => {
  it("only trusted absent→present add plus proven missing lane pin permits birth", async () => {
    operation.action = "add";
    operation.baseCatalog = catalog("preview, production");
    readNodeDeployPinState.mockImplementation(async (input) =>
      input.env === "candidate-a"
        ? { kind: "missing" }
        : { kind: "ok", sha: custodianPin }
    );
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(prepareNodeRefCandidateFlight).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha: birth })
    );
    expect(promoteNode).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha: custodianPin })
    );
  });
  it.each([
    "invalid",
    "unreadable",
    "existing",
  ])("%s pin is never birth", async (cause) => {
    operation.action = "add";
    operation.baseCatalog = catalog(
      cause === "existing" ? undefined : "preview, production"
    );
    readNodeDeployPinState.mockImplementation(async (input) => {
      if (input.env === "production") return { kind: "ok", sha: custodianPin };
      if (cause === "unreadable") throw new Error("read failed");
      return cause === "invalid" ? { kind: "invalid" } : { kind: "missing" };
    });
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
  });
  it("custodian missing is never allowed to use birth on genuine lane add", async () => {
    operation.action = "add";
    operation.baseCatalog = catalog("preview, production");
    readNodeDeployPinState.mockResolvedValue({ kind: "missing" });
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
  });
  it.each([
    "delivery",
    "redelivery",
  ])("old REMOVE %s after ADD has zero effects", async (delivery) => {
    operation.action = "remove";
    operation.headCatalog = catalog("preview, production");
    // Authentication still succeeds for the historical REMOVE. Current MAIN has a later ADD.
    fetchFileText.mockResolvedValue(catalog());
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(fetchFileText).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "main", path: "infra/catalog/toks5.yaml" })
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ dispatched: 0, outcome: "superseded" }),
      "feature.lane_onboard.complete"
    );
    if (delivery === "redelivery") {
      dispatchLaneOnboard(payload(), env, log);
      await settle();
      zeroEffects();
    }
  });
  it.each([
    "missing",
    "unreadable",
    "foreign-node",
    "malformed",
  ])("REMOVE refuses %s current desired state before effects", async (cause) => {
    operation.action = "remove";
    operation.headCatalog = catalog("preview, production");
    fetchFileText.mockImplementation(async () => {
      if (cause === "unreadable") throw new Error("GitHub unavailable");
      if (cause === "missing") return null;
      if (cause === "malformed") return "envs: null\n";
      return catalog("preview, production").replace(nodeId, "another-node");
    });
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    zeroEffects();
    expect(log.error).toHaveBeenCalled();
  });
  it("signed removal keeps the existing prune owner", async () => {
    operation.action = "remove";
    operation.headCatalog = catalog("preview, production");
    fetchFileText.mockResolvedValue(String(operation.headCatalog));
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(pruneNodeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ env: "candidate-a", controlEnv: "production" })
    );
    expect(promoteNode).not.toHaveBeenCalled();
    expect(prepareNodeRefCandidateFlight).not.toHaveBeenCalled();
  });
});

describe("retained onboarding regressions", () => {
  it.each([
    "unmerged",
    "foreign-repository",
    "foreign-owner",
  ])("%s event is a no-op", async (cause) => {
    const event = payload();
    if (cause === "unmerged") event.pull_request.merged = false;
    if (cause === "foreign-repository") event.repository.name = "other";
    if (cause === "foreign-owner") event.repository.owner.login = "other";
    dispatchLaneOnboard(event, env, log);
    await settle();
    zeroEffects();
    expect(classifyEnvManagerPr).not.toHaveBeenCalled();
  });
  it("hyphenated slug resolves the entire node name before the lane suffix", async () => {
    const event = payload();
    event.pull_request.head.ref =
      "cogni-operator/node-env-node-template-candidate-a";
    operation.targetNodeRef = "node-template";
    operation.baseCatalog = catalog().replace(
      "name: toks5",
      "name: node-template"
    );
    operation.headCatalog = operation.baseCatalog;
    fetchFileText.mockResolvedValue(String(operation.headCatalog));
    dispatchLaneOnboard(event, env, log);
    await settle();
    expect(prepareNodeRefCandidateFlight).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "node-template", sourceSha: lanePin })
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "node-template", dispatched: 2 }),
      "feature.lane_onboard.complete"
    );
  });
  it("isolated-fleet add replays its candidate custodian before preview at each own pin", async () => {
    operation.action = "add";
    operation.environment = "preview";
    operation.baseCatalog = catalog("production");
    readNodeDeployPinState.mockImplementation(async (input) => ({
      kind: "ok",
      sha: input.env === "candidate-a" ? custodianPin : lanePin,
    }));
    dispatchLaneOnboard(
      payload("preview"),
      { ...env, FLEET_CONTROL_ENV: "candidate-a" },
      log
    );
    await settle();
    expect(prepareNodeRefCandidateFlight).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha: custodianPin })
    );
    expect(promoteNode).toHaveBeenCalledWith(
      expect.objectContaining({ env: "preview", sourceSha: lanePin })
    );
    expect(
      prepareNodeRefCandidateFlight.mock.invocationCallOrder[0]
    ).toBeLessThan(promoteNode.mock.invocationCallOrder[0] ?? 0);
    expect(promoteNode).not.toHaveBeenCalledWith(
      expect.objectContaining({ env: "production" })
    );
  });
  it("isolated-fleet remove uses candidate-a custody", async () => {
    operation.action = "remove";
    operation.headCatalog = catalog("preview, production");
    fetchFileText.mockResolvedValue(String(operation.headCatalog));
    dispatchLaneOnboard(
      payload(),
      { ...env, FLEET_CONTROL_ENV: "candidate-a" },
      log
    );
    await settle();
    expect(pruneNodeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ env: "candidate-a", controlEnv: "candidate-a" })
    );
    expect(promoteNode).not.toHaveBeenCalled();
    expect(prepareNodeRefCandidateFlight).not.toHaveBeenCalled();
  });
  it.each([
    "akash",
    "k3s",
  ])("remove resolves removed lane's OWN %s provider, not surviving lanes", async (removed) => {
    operation.action = "remove";
    const survivor = removed === "akash" ? "k3s" : "akash";
    operation.baseCatalog = catalog()
      .replace("candidate-a: akash", `candidate-a: ${removed}`)
      .replace("preview: akash", `preview: ${survivor}`);
    operation.headCatalog = `name: toks5\nnode_id: ${nodeId}\nenvs: [preview, production]\ndeployment_provider: {preview: ${survivor}, production: k3s}\n`;
    fetchFileText.mockImplementation(async (input) =>
      (input as { ref: string }).ref === "main"
        ? String(operation.headCatalog)
        : String(operation.baseCatalog)
    );
    dispatchLaneOnboard(payload(), env, log);
    await settle();
    expect(fetchFileText).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: parentSha,
        path: "infra/catalog/toks5.yaml",
      })
    );
    expect(pruneNodeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: "candidate-a",
        controlEnv: removed === "akash" ? "production" : "candidate-a",
      })
    );
    expect(promoteNode).not.toHaveBeenCalled();
    expect(prepareNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(
      log.info.mock.calls.filter(
        (call) => call[1] === "feature.lane_onboard.complete"
      )
    ).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });
});
