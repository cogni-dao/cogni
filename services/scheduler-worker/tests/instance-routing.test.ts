// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/instance-routing.test`
 * Purpose: Pin instance routing (story.5159 step 1, design hub `candidate-pr-lanes`). A run names an
 *   instance; the worker resolves it from the operator directory, never from run input, and never falls back
 *   to the main copy. Falsifiers: `main` callbacks are unchanged; a canary run's callbacks hit the canary
 *   host; an unknown or closed instance sends NO request (so no token) to any node host; an operator outage
 *   serves only an instance the last good read listed.
 * Scope: Real directory client + real run-http adapters + real activities over a stubbed global fetch that
 *   records every request. A fake clock drives the cache.
 * @internal
 */

import { SYSTEM_ACTOR } from "@cogni/ids/system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string) =>
      Object.assign(new Error(message), { type, nonRetryable: true }),
    retryable: (message: string, type?: string) =>
      Object.assign(new Error(message), { type, nonRetryable: false }),
  },
  activityInfo: () => ({
    attempt: 1,
    workflowExecution: { workflowId: "wf", runId: "run" },
  }),
}));

import { createActivities } from "../src/activities/index.js";
import {
  createInstanceDirectory,
  DIRECTORY_MISS_REFRESH_MS,
  DIRECTORY_TTL_MS,
  deployEnvOfNamespace,
} from "../src/adapters/instance-directory.js";
import {
  createHttpExecutionGrantValidator,
  createHttpGraphRunWriter,
} from "../src/adapters/run-http.js";
import { createMockApiSuccessResponse, FIXED_IDS } from "./fixtures.js";

const NODE_ID = "f66b260b-4633-41e2-8711-b7c1b8449cc1";
const OPERATOR = "https://operator.example";
const SCHEDULER_TOKEN = "scheduler-token-min-32-characters-long";
const DIRECTORY_TOKEN = "directory-token-min-32-characters-long";
const MAIN_URL = "http://main-app:3000";
const CANARY_HOST = "toks5-canary-test.cognidao.org";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Parameters<typeof createHttpGraphRunWriter>[0]["logger"];

type Listing = readonly { instance: string; host: string }[];

/** The operator the stub fetch plays: what the directory lists, or that it is down. */
const operator = {
  listing: [] as Listing,
  down: false,
  status: 200,
  env: "candidate-a",
};

let requests: { url: string; auth: string | undefined }[];
let fetchMock: ReturnType<typeof vi.fn>;
let clock: number;

/** Compare parsed origins, never URL prefixes. */
const isOperator = (url: string) => new URL(url).origin === OPERATOR;
const directoryReads = () =>
  requests.filter(
    (r) =>
      isOperator(r.url) &&
      new URL(r.url).pathname === "/api/v1/deploy/instances"
  );
const nodeCalls = () => requests.filter((r) => !isOperator(r.url));

beforeEach(() => {
  operator.listing = [{ instance: "canary", host: CANARY_HOST }];
  operator.down = false;
  operator.status = 200;
  operator.env = "candidate-a";
  requests = [];
  clock = 1_000_000;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    requests.push({ url, auth });
    if (isOperator(url)) {
      if (operator.down) throw new TypeError("fetch failed");
      if (operator.status !== 200)
        return new Response("{}", { status: operator.status });
      return new Response(
        JSON.stringify({
          nodeId: NODE_ID,
          env: operator.env,
          asOf: "now",
          instances: operator.listing,
        }),
        { status: 200 }
      );
    }
    // a node host: the graph route answers a success body; run/grant routes answer ok
    return new Response(JSON.stringify(createMockApiSuccessResponse()), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function build() {
  const instanceResolver = createInstanceDirectory({
    baseUrl: OPERATOR,
    token: DIRECTORY_TOKEN,
    env: "candidate-a",
    logger,
    now: () => clock,
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  const deps = {
    nodeEndpoints: new Map([[NODE_ID, MAIN_URL]]),
    schedulerApiToken: SCHEDULER_TOKEN,
    logger,
    instanceResolver,
  };
  const activities = createActivities({
    grantAdapter: createHttpExecutionGrantValidator(deps),
    runAdapter: createHttpGraphRunWriter(deps),
    nodePrincipalResolver: { resolve: vi.fn() },
    config: {
      nodeEndpoints: deps.nodeEndpoints,
      schedulerApiToken: SCHEDULER_TOKEN,
      instanceResolver,
    },
    logger,
  });
  return { activities, deps };
}

const execute = (
  activities: ReturnType<typeof build>["activities"],
  instance?: string
) =>
  activities.executeGraphActivity({
    nodeId: NODE_ID,
    graphId: FIXED_IDS.graphId,
    executionGrantId: null,
    input: { messages: [] },
    scheduledFor: "2026-11-18T00:00:00.000Z",
    runId: FIXED_IDS.runId,
    ...(instance !== undefined && { instance }),
  });

describe("main is unchanged", () => {
  it.each([
    undefined,
    "main",
  ])("instance %s resolves from COGNI_NODE_ENDPOINTS and never reads the directory", async (instance) => {
    const { activities } = build();
    await execute(activities, instance);
    expect(directoryReads()).toHaveLength(0);
    expect(nodeCalls()).toEqual([
      {
        url: `${MAIN_URL}/api/internal/graphs/${FIXED_IDS.graphId}/runs`,
        auth: `Bearer ${SCHEDULER_TOKEN}`,
      },
    ]);
  });

  it("an unknown node still fails as before, with no request", async () => {
    const { activities } = build();
    await expect(
      activities.executeGraphActivity({
        nodeId: "ghost",
        graphId: FIXED_IDS.graphId,
        executionGrantId: null,
        input: {},
        scheduledFor: "2026-11-18T00:00:00.000Z",
        runId: FIXED_IDS.runId,
      })
    ).rejects.toMatchObject({ type: "UNKNOWN_NODE", nonRetryable: true });
    expect(requests).toHaveLength(0);
  });
});

describe("a canary instance resolves through the directory", () => {
  it("calls the canary host, with the scheduler token and the directory token each on its own request", async () => {
    const { activities } = build();
    await execute(activities, "canary");
    expect(requests).toEqual([
      {
        url: `${OPERATOR}/api/v1/deploy/instances?nodeId=${NODE_ID}&env=candidate-a`,
        auth: `Bearer ${DIRECTORY_TOKEN}`,
      },
      {
        url: `https://${CANARY_HOST}/api/internal/graphs/${FIXED_IDS.graphId}/runs`,
        auth: `Bearer ${SCHEDULER_TOKEN}`,
      },
    ]);
  });

  it("routes the run ledger writes and the grant check to the canary host too", async () => {
    const { deps } = build();
    const writer = createHttpGraphRunWriter(deps);
    const grants = createHttpExecutionGrantValidator(deps);
    await writer.createRun(
      SYSTEM_ACTOR,
      NODE_ID,
      { runId: FIXED_IDS.runId },
      "canary"
    );
    await writer.markRunStarted(
      SYSTEM_ACTOR,
      NODE_ID,
      FIXED_IDS.runId,
      undefined,
      "canary"
    );
    await writer.markRunCompleted(
      SYSTEM_ACTOR,
      NODE_ID,
      FIXED_IDS.runId,
      "success",
      undefined,
      undefined,
      "canary"
    );
    await grants
      .validateGrantForGraph(
        SYSTEM_ACTOR,
        NODE_ID,
        FIXED_IDS.grantId,
        FIXED_IDS.graphId,
        "canary"
      )
      .catch(() => undefined); // the stub answers no grant body; only the target host matters
    const hosts = nodeCalls().map((r) => new URL(r.url).host);
    expect(hosts).toHaveLength(4);
    expect(new Set(hosts)).toEqual(new Set([CANARY_HOST]));
    expect(directoryReads()).toHaveLength(1);
  });

  it("reuses one directory read inside the 60 s TTL", async () => {
    const { activities } = build();
    await execute(activities, "canary");
    clock += DIRECTORY_TTL_MS - 1;
    await execute(activities, "canary");
    expect(directoryReads()).toHaveLength(1);
    clock += 2;
    await execute(activities, "canary");
    expect(directoryReads()).toHaveLength(2);
  });

  it("finds an instance that opened after a recent read once the miss window passes", async () => {
    const { activities } = build();
    operator.listing = [];
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      nonRetryable: true,
    });
    operator.listing = [{ instance: "canary", host: CANARY_HOST }];
    // inside the miss window the cached "absent" answer stands: no new read
    clock += DIRECTORY_MISS_REFRESH_MS - 1;
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(directoryReads()).toHaveLength(1);
    clock += 2;
    await execute(activities, "canary");
    expect(directoryReads()).toHaveLength(2);
    expect(nodeCalls()).toHaveLength(1);
  });
});

describe("an unknown or closed instance sends nothing to any node host", () => {
  it("refuses an instance the directory does not list: non-retryable, no node request, never main", async () => {
    const { activities } = build();
    await expect(execute(activities, "pr-999")).rejects.toMatchObject({
      type: "UNKNOWN_INSTANCE",
      nonRetryable: true,
    });
    expect(nodeCalls()).toEqual([]);
    expect(requests.every((r) => r.auth === `Bearer ${DIRECTORY_TOKEN}`)).toBe(
      true
    );
  });

  it("refuses the run ledger writes of an unknown instance before any request to a node", async () => {
    const { deps } = build();
    const writer = createHttpGraphRunWriter(deps);
    await expect(
      writer.createRun(
        SYSTEM_ACTOR,
        NODE_ID,
        { runId: FIXED_IDS.runId },
        "pr-999"
      )
    ).rejects.toMatchObject({ name: "RunHttpClientError", retryable: false });
    expect(nodeCalls()).toEqual([]);
  });

  it("refuses an invalid instance name without even reading the directory", async () => {
    const { activities } = build();
    await expect(
      execute(activities, "https://evil.example/")
    ).rejects.toMatchObject({ type: "UNKNOWN_INSTANCE", nonRetryable: true });
    expect(requests).toEqual([]);
  });

  it("refuses every non-main instance when this worker has no directory", async () => {
    const endpoints = new Map([[NODE_ID, MAIN_URL]]);
    const activities = createActivities({
      grantAdapter: {} as never,
      runAdapter: {} as never,
      nodePrincipalResolver: { resolve: vi.fn() },
      config: { nodeEndpoints: endpoints, schedulerApiToken: SCHEDULER_TOKEN },
      logger,
    });
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      type: "UNKNOWN_INSTANCE",
      nonRetryable: true,
    });
    expect(requests).toEqual([]);
  });

  it("ignores a directory host that is not a bare hostname", async () => {
    operator.listing = [
      { instance: "canary", host: "https://evil.example/x" },
      { instance: "pr-1", host: "evil.example:8080" },
    ];
    const { activities } = build();
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      nonRetryable: true,
    });
    await expect(execute(activities, "pr-1")).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(nodeCalls()).toEqual([]);
  });
});

describe("operator outage", () => {
  it("uses the last good copy for an instance it listed", async () => {
    const { activities } = build();
    await execute(activities, "canary");
    operator.down = true;
    clock += DIRECTORY_TTL_MS + 1;
    await execute(activities, "canary");
    const hosts = nodeCalls().map((r) => new URL(r.url).host);
    expect(hosts).toEqual([CANARY_HOST, CANARY_HOST]);
    expect(directoryReads()).toHaveLength(2);
  });

  it("a 5xx from the operator counts as unreachable and also serves the last good copy", async () => {
    const { activities } = build();
    await execute(activities, "canary");
    operator.status = 503;
    clock += DIRECTORY_TTL_MS + 1;
    await execute(activities, "canary");
    expect(nodeCalls()).toHaveLength(2);
  });

  it("never serves an instance the last good read did not list", async () => {
    const { activities } = build();
    await execute(activities, "canary");
    operator.down = true;
    clock += DIRECTORY_TTL_MS + 1;
    await expect(execute(activities, "pr-999")).rejects.toMatchObject({
      type: "UNKNOWN_INSTANCE",
      nonRetryable: true,
    });
    expect(nodeCalls()).toHaveLength(1); // only the first canary call
  });

  it("refuses a closed instance even with a last good copy that once listed it", async () => {
    const { activities } = build();
    await execute(activities, "canary");
    // canary closes: the next successful read no longer lists it
    operator.listing = [];
    clock += DIRECTORY_TTL_MS + 1;
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      nonRetryable: true,
    });
    // the operator then goes down: the last good copy is the read that reported it absent
    operator.down = true;
    clock += DIRECTORY_TTL_MS + 1;
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      type: "UNKNOWN_INSTANCE",
      nonRetryable: true,
    });
    expect(nodeCalls()).toHaveLength(1); // only the call made while canary was open
  });

  it("is retryable, and sends nothing, when the operator is down and nothing was ever read", async () => {
    operator.down = true;
    const { activities } = build();
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      type: "UNKNOWN_INSTANCE",
      nonRetryable: false,
    });
    expect(nodeCalls()).toEqual([]);
  });

  it.each([
    401, 403, 400, 409,
  ])("a %s from the operator is final: the last good copy is not used", async (status) => {
    const { activities } = build();
    await execute(activities, "canary");
    operator.status = status;
    clock += DIRECTORY_TTL_MS + 1;
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(nodeCalls()).toHaveLength(1);
  });

  it("a directory answering another env is refused", async () => {
    operator.env = "production";
    const { activities } = build();
    await expect(execute(activities, "canary")).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(nodeCalls()).toEqual([]);
  });
});

describe("deployEnvOfNamespace", () => {
  it("maps a cogni-<env> namespace to its env and refuses others", () => {
    expect(deployEnvOfNamespace("cogni-candidate-a")).toBe("candidate-a");
    expect(deployEnvOfNamespace("cogni-production")).toBe("production");
    expect(deployEnvOfNamespace("cogni-preview")).toBe("preview");
    expect(deployEnvOfNamespace("default")).toBeUndefined();
    expect(deployEnvOfNamespace("cogni-dev")).toBeUndefined();
  });
});
