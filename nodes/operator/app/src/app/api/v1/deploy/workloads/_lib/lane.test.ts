// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/lane` (test)
 * Purpose: Pin the lane refusals of the one-front-door verb (story.5137 CD4): the production operator serves
 *   every env of a canonical Akash node; the test operator (a different fleet org) refuses canonical nodes;
 *   an env outside the served set is refused; and a lane the catalog has not handed to the verb is never
 *   recorded.
 * Scope: Pure decisions over catalog rows; `serverEnv` and the operator node id are mocked.
 * Side-effects: none
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OPERATOR_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const TOKS5_ID = "b927a9dd-0000-4000-8000-0000000000aa";

const env: {
  DEPLOY_ENVIRONMENT?: string | undefined;
  FLEET_CONTROL_ENV?: string | undefined;
  NODE_DEPLOY_ENVS?: string | undefined;
  NODE_SUBMODULE_PARENT_OWNER?: string | undefined;
  NODE_DEPLOY_WORKLOAD_ZONE?: string | undefined;
} = {};
vi.mock("@/shared/env", () => ({ serverEnv: () => env }));
vi.mock("@/shared/config", () => ({ getNodeId: () => OPERATOR_ID }));

import {
  envNotServed,
  laneControlEnv,
  nodeNotOnDeployVerb,
  servedEnvs,
} from "./lane";

/** A canonical Akash node: candidate-a and production on the verb, preview with no cell. */
const AKASH_NODE = {
  name: "toks5",
  source_repo: "https://github.com/cogni-dao/toks5.git",
  deployment_provider: {
    "candidate-a": "akash",
    preview: "akash",
    production: "akash",
  },
  compute_api: {
    "candidate-a": "node-deploy",
    production: "node-deploy",
  },
};
/** A k3s node by default: no placement, no compute_api. */
const K3S_NODE = {
  name: "beacon",
  source_repo: "https://github.com/cogni-dao/beacon.git",
};
const OPERATOR_ROW = { name: "operator" };

async function bodyOf(res: Response | undefined): Promise<unknown> {
  return res?.json();
}

function productionOperator(): void {
  env.DEPLOY_ENVIRONMENT = "production";
  env.FLEET_CONTROL_ENV = "production";
  env.NODE_DEPLOY_ENVS = "candidate-a,preview,production";
  env.NODE_SUBMODULE_PARENT_OWNER = "cogni-dao";
  env.NODE_DEPLOY_WORKLOAD_ZONE = "cognidao.org";
}

function testOperator(): void {
  env.DEPLOY_ENVIRONMENT = "candidate-a";
  env.FLEET_CONTROL_ENV = "candidate-a";
  env.NODE_DEPLOY_ENVS = undefined;
  env.NODE_SUBMODULE_PARENT_OWNER = "cogni-test-org";
  env.NODE_DEPLOY_WORKLOAD_ZONE = "cogni-testing.org";
}

describe("servedEnvs", () => {
  it("is NODE_DEPLOY_ENVS when set, else only DEPLOY_ENVIRONMENT, else none", () => {
    expect(
      servedEnvs({ NODE_DEPLOY_ENVS: " candidate-a, preview ,production" })
    ).toEqual(["candidate-a", "preview", "production"]);
    expect(servedEnvs({ DEPLOY_ENVIRONMENT: "candidate-a" })).toEqual([
      "candidate-a",
    ]);
    expect(servedEnvs({})).toEqual([]);
  });
});

describe("laneControlEnv: which env's control plane reconciles a node's lane", () => {
  it("is the fleet control env for an Akash lane of any non-production env, and production for production", () => {
    for (const e of ["candidate-a", "preview", "production"] as const)
      expect(laneControlEnv(AKASH_NODE, e, "production")).toBe("production");
    // an isolated fleet reconciles its own Akash lanes
    expect(laneControlEnv(AKASH_NODE, "candidate-a", "candidate-a")).toBe(
      "candidate-a"
    );
  });

  it("is the env itself for a k3s (default) lane or an unknown node", () => {
    expect(laneControlEnv(K3S_NODE, "candidate-a", "production")).toBe(
      "candidate-a"
    );
    expect(laneControlEnv(undefined, "preview", "production")).toBe("preview");
  });

  it("treats a node-deploy cell as Akash-placed even when deployment_provider is absent", () => {
    const row = { name: "x", compute_api: { preview: "node-deploy" } };
    expect(laneControlEnv(row, "preview", "production")).toBe("production");
  });
});

describe("envNotServed: the served env set and the fleet (CD4 a, b)", () => {
  beforeEach(productionOperator);

  it("the production operator serves candidate-a, preview and production for a canonical Akash node", () => {
    for (const e of ["candidate-a", "preview", "production"] as const)
      expect(envNotServed(e, TOKS5_ID, AKASH_NODE), e).toBeUndefined();
  });

  it("refuses an env outside the served set, naming the served set", async () => {
    env.NODE_DEPLOY_ENVS = "candidate-a,preview";
    const res = envNotServed("production", TOKS5_ID, AKASH_NODE);
    expect(res?.status).toBe(409);
    expect(await bodyOf(res)).toEqual({
      error: "env_not_served",
      served: ["candidate-a", "preview"],
    });
  });

  it("refuses a k3s node's non-production lane: its control env is not the fleet control env", async () => {
    const res = envNotServed("candidate-a", TOKS5_ID, K3S_NODE);
    expect(res?.status).toBe(409);
    expect(await bodyOf(res)).toMatchObject({
      error: "env_not_served",
      controlEnv: "candidate-a",
    });
  });

  it("refuses a node the catalog does not know or another fleet owns (node_not_in_fleet)", async () => {
    for (const row of [
      undefined,
      { ...AKASH_NODE, source_repo: "https://github.com/cogni-test-org/x.git" },
    ]) {
      const res = envNotServed("candidate-a", TOKS5_ID, row);
      expect(res?.status).toBe(409);
      expect(await bodyOf(res)).toEqual({ error: "node_not_in_fleet" });
    }
  });

  it("matches the fleet org case-insensitively", () => {
    env.NODE_SUBMODULE_PARENT_OWNER = "Cogni-DAO";
    expect(envNotServed("preview", TOKS5_ID, AKASH_NODE)).toBeUndefined();
  });

  it("the operator's own canary is served only in its own DEPLOY_ENVIRONMENT, as before", () => {
    expect(
      envNotServed("production", OPERATOR_ID, OPERATOR_ROW)
    ).toBeUndefined();
    expect(envNotServed("candidate-a", OPERATOR_ID, OPERATOR_ROW)?.status).toBe(
      409
    );
  });

  it("is a 503 when the deployment serves no env at all", async () => {
    env.DEPLOY_ENVIRONMENT = undefined;
    env.NODE_DEPLOY_ENVS = undefined;
    const res = envNotServed("candidate-a", TOKS5_ID, AKASH_NODE);
    expect(res?.status).toBe(503);
    expect(await bodyOf(res)).toEqual({
      error: "deploy_environment_not_configured",
    });
  });
});

describe("the test operator never serves canonical nodes (CD4 b)", () => {
  beforeEach(testOperator);

  it.each([
    undefined,
    "https://invalid/zone",
  ])("keeps scoped reads independent of new DNS admission (%s)", async (zone) => {
    env.NODE_DEPLOY_WORKLOAD_ZONE = zone;
    const own = {
      ...AKASH_NODE,
      source_repo: "https://github.com/cogni-test-org/own",
    };
    expect(envNotServed("candidate-a", TOKS5_ID, own)).toBeUndefined();
    expect(
      envNotServed("candidate-a", OPERATOR_ID, OPERATOR_ROW)
    ).toBeUndefined();
    expect(
      await bodyOf(envNotServed("candidate-a", TOKS5_ID, AKASH_NODE))
    ).toEqual({ error: "node_not_in_fleet" });
    expect(envNotServed("production", TOKS5_ID, own)?.status).toBe(409);
  });

  it("refuses canonical toks5 in candidate-a: it is another fleet's node, though its catalog is baked into the test image", async () => {
    const res = envNotServed("candidate-a", TOKS5_ID, AKASH_NODE);
    expect(res?.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "node_not_in_fleet" });
  });

  it("refuses canonical production and preview too (env outside its served set)", () => {
    expect(envNotServed("production", TOKS5_ID, AKASH_NODE)?.status).toBe(409);
    expect(envNotServed("preview", TOKS5_ID, AKASH_NODE)?.status).toBe(409);
  });

  it("serves its OWN fleet's Akash node in candidate-a", () => {
    const own = {
      ...AKASH_NODE,
      source_repo: "https://github.com/cogni-test-org/own.git",
    };
    expect(envNotServed("candidate-a", TOKS5_ID, own)).toBeUndefined();
  });
});

describe("nodeNotOnDeployVerb: ONE_WRITER_PER_NODE_LANE (CD4 c)", () => {
  it("admits only a lane whose catalog cell is node-deploy", () => {
    expect(
      nodeNotOnDeployVerb("candidate-a", TOKS5_ID, AKASH_NODE)
    ).toBeUndefined();
    expect(
      nodeNotOnDeployVerb("production", TOKS5_ID, AKASH_NODE)
    ).toBeUndefined();
  });

  it("refuses 409 node_not_on_deploy_verb for a missing cell, a k3s row and an unknown node", async () => {
    const missing = nodeNotOnDeployVerb("preview", TOKS5_ID, AKASH_NODE);
    expect(missing?.status).toBe(409);
    expect(await bodyOf(missing)).toMatchObject({
      error: "node_not_on_deploy_verb",
    });
    expect(nodeNotOnDeployVerb("candidate-a", TOKS5_ID, K3S_NODE)?.status).toBe(
      409
    );
    expect(
      nodeNotOnDeployVerb("candidate-a", TOKS5_ID, undefined)?.status
    ).toBe(409);
  });

  it("refuses a catalog row it cannot parse instead of guessing", () => {
    const bad = { name: "x", compute_api: { preview: "nonsense" } };
    expect(nodeNotOnDeployVerb("preview", TOKS5_ID, bad)?.status).toBe(409);
  });

  it("exempts the operator's own canary (in-repo, no compute_api row)", () => {
    expect(
      nodeNotOnDeployVerb("production", OPERATOR_ID, OPERATOR_ROW)
    ).toBeUndefined();
  });
});
