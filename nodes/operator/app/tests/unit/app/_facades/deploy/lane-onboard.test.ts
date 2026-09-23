// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/deploy/lane-onboard`
 * Purpose: Unit tests for the env-membership merge → lane reconcile facade.
 * Scope: Mocked deploy plane only; no real GitHub I/O.
 * Invariants: VERB_BRANCH_ONLY, CATALOG_AFTER_MERGE_DECIDES, SUBSTRATE_FOLLOWS_THE_CUSTODIAN,
 *   NAME_AND_PATH_FOLLOW_THE_LANE, REPLAY_NEVER_ADVANCES, ONE_EVENT.
 * Side-effects: none
 * Links: src/app/_facades/deploy/lane-onboard.server.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const promoteNode = vi.fn(async () => ({ status: "dispatched" }));
const prepareNodeRefCandidateFlight = vi.fn(async () => ({
  nodeId: "f66b260b",
  slug: "toks5",
  sourceSha: "c".repeat(40),
  sourceRepo: "https://github.com/cogni-dao/toks5.git",
  image: "ghcr.io/cogni-dao/toks5:sha-c",
}));
const dispatchNodeRefCandidateFlight = vi.fn(async () => ({
  workflowUrl: "https://github.com/x/y/actions",
}));
let catalogText: string | null = null;
const fetchFileText = vi.fn(async () => catalogText);
/** `deploy/<env>-<slug>` pins by env — what each env is ACTUALLY running. */
let deployPins: Record<string, string> = {};
const readNodeDeployPin = vi.fn(
  async (input: { env: string }) => deployPins[input.env] ?? null
);

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({
    promoteNode,
    prepareNodeRefCandidateFlight,
    dispatchNodeRefCandidateFlight,
    fetchFileText,
    readNodeDeployPin,
  }),
}));

import { dispatchLaneOnboard } from "@/app/_facades/deploy/lane-onboard.server";

const ENV = {
  GH_REVIEW_APP_ID: "123",
  GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
  NODE_SUBMODULE_PARENT_OWNER: "Cogni-DAO",
  NODE_SUBMODULE_PARENT_REPO: "cogni",
  // biome-ignore lint/suspicious/noExplicitAny: partial ServerEnv is sufficient for this facade
} as any;

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino Logger stub
} as any;

/** An akash row whose non-production lanes are custodied by production. */
const AKASH_ROW = [
  "name: toks5",
  "node_id: f66b260b-a859-4399-888e-a8c7a6696f7e",
  `source_sha: ${"c".repeat(40)}`,
  "envs: [candidate-a, preview, production]",
  "deployment_provider:",
  "  candidate-a: akash",
  "  preview: akash",
  "  production: akash",
].join("\n");

function mergedPayload(
  headRef: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    action: "closed",
    repository: { name: "cogni", owner: { login: "Cogni-DAO" } },
    pull_request: {
      number: 2360,
      merged: true,
      head: { ref: headRef, sha: "a".repeat(40) },
    },
    ...over,
  };
}

/** Let the facade's fire-and-forget promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The catalog's birth pin for AKASH_ROW. */
const BIRTH_SHA = "c".repeat(40);
/** What production is really running — deliberately NOT the birth pin. */
const PROD_PIN = "1".repeat(40);
/** What candidate-a last flighted. */
const CANDIDATE_PIN = "2".repeat(40);

beforeEach(() => {
  vi.clearAllMocks();
  catalogText = AKASH_ROW;
  deployPins = {};
});

describe("dispatchLaneOnboard — VERB_BRANCH_ONLY", () => {
  it("no-ops on an ordinary merged PR", async () => {
    dispatchLaneOnboard(mergedPayload("flock-leader/some-fix"), ENV, log);
    await settle();
    expect(fetchFileText).not.toHaveBeenCalled();
    expect(promoteNode).not.toHaveBeenCalled();
    expect(dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
  });

  it("no-ops on an unmerged (closed) env PR", async () => {
    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-preview", {
        pull_request: {
          number: 1,
          merged: false,
          head: { ref: "cogni-operator/node-env-toks5-preview" },
        },
      }),
      ENV,
      log
    );
    await settle();
    expect(fetchFileText).not.toHaveBeenCalled();
  });

  it("no-ops when the same branch name lands on a node's own repo", async () => {
    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-preview", {
        repository: { name: "toks5", owner: { login: "cogni-dao" } },
      }),
      ENV,
      log
    );
    await settle();
    expect(fetchFileText).not.toHaveBeenCalled();
  });

  it("splits a slug that contains dashes from its lane suffix", async () => {
    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-node-template-candidate-a"),
      ENV,
      log
    );
    await settle();
    expect(fetchFileText).toHaveBeenCalledWith(
      expect.objectContaining({ path: "infra/catalog/node-template.yaml" })
    );
  });
});

describe("dispatchLaneOnboard — dispatch selection", () => {
  it("SUBSTRATE_FOLLOWS_THE_CUSTODIAN: a preview add dispatches production then the lane", async () => {
    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-preview"),
      ENV,
      log
    );
    await settle();

    expect(promoteNode).toHaveBeenCalledTimes(2);
    expect(promoteNode.mock.calls[0]?.[0]).toMatchObject({
      env: "production",
      slug: "toks5",
    });
    expect(promoteNode.mock.calls[1]?.[0]).toMatchObject({
      env: "preview",
      slug: "toks5",
    });
    // A birth lane on both envs — no pin anywhere — legitimately falls back to the catalog row.
    expect(promoteNode.mock.calls[0]?.[0]).toMatchObject({
      sourceSha: BIRTH_SHA,
    });
    expect(dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
  });

  it("NAME_AND_PATH_FOLLOW_THE_LANE: a candidate-a add renders through the flight lever", async () => {
    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-candidate-a"),
      ENV,
      log
    );
    await settle();

    // Custodian first (production), then the lane's own render via flight — never promoteNode
    // at env=candidate-a, which the promote lever does not accept.
    expect(promoteNode).toHaveBeenCalledTimes(1);
    expect(promoteNode.mock.calls[0]?.[0]).toMatchObject({ env: "production" });
    expect(prepareNodeRefCandidateFlight).toHaveBeenCalledTimes(1);
    expect(dispatchNodeRefCandidateFlight).toHaveBeenCalledTimes(1);
  });

  it("fires ONE dispatch when the lane IS its own custodian (k3s)", async () => {
    catalogText = [
      "name: levelup",
      "node_id: 11111111-2222-3333-4444-555555555555",
      `source_sha: ${"d".repeat(40)}`,
      "envs: [preview, production]",
      "deployment_provider:",
      "  preview: k3s",
    ].join("\n");

    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-levelup-preview"),
      ENV,
      log
    );
    await settle();

    expect(promoteNode).toHaveBeenCalledTimes(1);
    expect(promoteNode.mock.calls[0]?.[0]).toMatchObject({ env: "preview" });
  });

  it("CATALOG_AFTER_MERGE_DECIDES: a REMOVE dispatches nothing", async () => {
    catalogText = [
      "name: toks5",
      "node_id: f66b260b-a859-4399-888e-a8c7a6696f7e",
      `source_sha: ${"c".repeat(40)}`,
      "envs: [candidate-a, production]",
      "deployment_provider:",
      "  candidate-a: akash",
    ].join("\n");

    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-preview"),
      ENV,
      log
    );
    await settle();

    expect(promoteNode).not.toHaveBeenCalled();
    expect(dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "removed", dispatched: 0 }),
      "feature.lane_onboard.complete"
    );
  });
});

describe("dispatchLaneOnboard — ONE_EVENT", () => {
  it("emits exactly one terminal event carrying the required fields", async () => {
    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-preview"),
      ENV,
      log
    );
    await settle();

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.lane_onboard.complete",
        slug: "toks5",
        env: "preview",
        controlEnv: "production",
        prNumber: 2360,
        dispatched: 2,
        outcome: "dispatched",
      }),
      "feature.lane_onboard.complete"
    );
  });

  it("reports a dispatch failure as one event with an errorCode, never throwing", async () => {
    promoteNode.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { code: "dispatch_failed" })
    );

    expect(() =>
      dispatchLaneOnboard(
        mergedPayload("cogni-operator/node-env-toks5-preview"),
        ENV,
        log
      )
    ).not.toThrow();
    await settle();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.lane_onboard.complete",
        outcome: "error",
        errorCode: "dispatch_failed",
      }),
      "feature.lane_onboard.complete"
    );
  });
});

describe("dispatchLaneOnboard — REPLAY_NEVER_ADVANCES (bug.5237)", () => {
  it("replays production's OWN pin, never the catalog birth sha, on a candidate-a add", async () => {
    // The exact 2026-09-23 shape: toks5 production had been promoted past its birth pin, then
    // `add toks5 to candidate-a` merged. The old code dispatched production @ the catalog row
    // and reverted the live host.
    deployPins = { production: PROD_PIN, "candidate-a": CANDIDATE_PIN };

    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-candidate-a"),
      ENV,
      log
    );
    await settle();

    expect(promoteNode).toHaveBeenCalledTimes(1);
    expect(promoteNode.mock.calls[0]?.[0]).toMatchObject({
      env: "production",
      sourceSha: PROD_PIN,
    });
    expect(promoteNode.mock.calls[0]?.[0]).not.toMatchObject({
      sourceSha: BIRTH_SHA,
    });
  });

  it("re-flights candidate-a at the sha it already flew, not the birth sha", async () => {
    deployPins = { production: PROD_PIN, "candidate-a": CANDIDATE_PIN };

    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-candidate-a"),
      ENV,
      log
    );
    await settle();

    expect(prepareNodeRefCandidateFlight).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha: CANDIDATE_PIN })
    );
  });

  it("uses the catalog birth sha only for an env with no pin yet", async () => {
    // Production is live; preview is being born. Each env gets its OWN answer.
    deployPins = { production: PROD_PIN };

    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-preview"),
      ENV,
      log
    );
    await settle();

    expect(promoteNode.mock.calls[0]?.[0]).toMatchObject({
      env: "production",
      sourceSha: PROD_PIN,
    });
    expect(promoteNode.mock.calls[1]?.[0]).toMatchObject({
      env: "preview",
      sourceSha: BIRTH_SHA,
    });
  });

  it("puts both rendered shas in the terminal event so a replay is auditable", async () => {
    deployPins = { production: PROD_PIN };

    dispatchLaneOnboard(
      mergedPayload("cogni-operator/node-env-toks5-preview"),
      ENV,
      log
    );
    await settle();

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        custodianSha8: PROD_PIN.slice(0, 8),
        laneSha8: BIRTH_SHA.slice(0, 8),
      }),
      "feature.lane_onboard.complete"
    );
  });
});
