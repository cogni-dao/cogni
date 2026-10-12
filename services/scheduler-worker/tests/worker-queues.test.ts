// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/worker-queues.test`
 * Purpose: Unit tests for per-node queue derivation helpers — the one place
 *   where submitter queue names and consumer queue names must agree.
 * Scope: Pure functions only; no Temporal or activity setup.
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  isCanonicalNodeId,
  nodeTaskQueueName,
  workerRoutes,
} from "../src/worker.js";

describe("isCanonicalNodeId", () => {
  it("accepts lowercase UUID v4 strings", () => {
    expect(isCanonicalNodeId("4ff8eac1-4eba-4ed0-931b-b1fe4f64713d")).toBe(
      true
    );
    expect(isCanonicalNodeId("5ed2d64f-2745-4676-983b-2fb7e05b2eba")).toBe(
      true
    );
  });

  it("accepts uppercase UUID", () => {
    expect(isCanonicalNodeId("4FF8EAC1-4EBA-4ED0-931B-B1FE4F64713D")).toBe(
      true
    );
  });

  it("rejects human slug aliases", () => {
    expect(isCanonicalNodeId("operator")).toBe(false);
    expect(isCanonicalNodeId("poly")).toBe(false);
    expect(isCanonicalNodeId("resy")).toBe(false);
  });

  it("rejects malformed UUID-ish strings (length, separators, chars)", () => {
    expect(isCanonicalNodeId("")).toBe(false);
    expect(isCanonicalNodeId("not-a-uuid")).toBe(false);
    expect(
      isCanonicalNodeId("4ff8eac14eba4ed0931bb1fe4f64713d") // no dashes
    ).toBe(false);
    expect(
      isCanonicalNodeId("4ff8eac1-4eba-4ed0-931b-b1fe4f64713dX") // trailing char
    ).toBe(false);
  });
});

describe("nodeTaskQueueName", () => {
  it("derives <prefix>-<nodeId>", () => {
    expect(
      nodeTaskQueueName(
        "scheduler-tasks",
        "5ed2d64f-2745-4676-983b-2fb7e05b2eba"
      )
    ).toBe("scheduler-tasks-5ed2d64f-2745-4676-983b-2fb7e05b2eba");
  });

  it(`must match what node-app submitters produce (\${prefix}-\${getNodeId()})`, () => {
    // This is the load-bearing invariant: if this spec breaks, dev/prod chat
    // stalls because submitter queue names no longer match worker queue names.
    const prefix = "scheduler-tasks";
    const nodeId = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
    const consumerQueue = nodeTaskQueueName(prefix, nodeId);
    const submitterQueue = `${prefix}-${nodeId}`;
    expect(consumerQueue).toBe(submitterQueue);
  });
});

describe("workerRoutes", () => {
  const primary =
    "operator=https://operator.example,4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=https://operator.example,poly=https://poly.example,4b06359a-a859-4399-888e-a8c7a6696f7e=https://poly.example";
  const candidate =
    "poly=https://poly-test.example,4b06359a-a859-4399-888e-a8c7a6696f7e=https://poly-test.example";

  it("bounds foreign lanes to their own node queues and omits legacy drain", () => {
    expect(
      workerRoutes(
        "cogni-production",
        primary,
        JSON.stringify({ "cogni-candidate-a": candidate }),
        "scheduler-tasks"
      )
    ).toEqual([
      {
        namespace: "cogni-production",
        endpointsRaw: primary,
        taskQueues: [
          "scheduler-tasks-4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
          "scheduler-tasks-4b06359a-a859-4399-888e-a8c7a6696f7e",
          "scheduler-tasks",
        ],
        isPrimary: true,
      },
      {
        namespace: "cogni-candidate-a",
        endpointsRaw: candidate,
        taskQueues: ["scheduler-tasks-4b06359a-a859-4399-888e-a8c7a6696f7e"],
        isPrimary: false,
      },
    ]);
  });

  it("fails closed on malformed custody JSON", () => {
    expect(() =>
      workerRoutes(
        "cogni-production",
        primary,
        "candidate-a",
        "scheduler-tasks"
      )
    ).toThrow("must be a JSON object");
  });

  it("rejects a custodied route without a canonical node UUID", () => {
    expect(() =>
      workerRoutes(
        "cogni-production",
        primary,
        JSON.stringify({
          "cogni-candidate-a": "poly=https://poly-test.example",
        }),
        "scheduler-tasks"
      )
    ).toThrow("has no canonical node UUID endpoint");
  });

  it("rejects the primary namespace in the custody map", () => {
    expect(() =>
      workerRoutes(
        "cogni-production",
        primary,
        JSON.stringify({ "cogni-production": candidate }),
        "scheduler-tasks"
      )
    ).toThrow("differ from primary namespace");
  });
});
