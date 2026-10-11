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
  workerNamespaces,
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

describe("workerNamespaces", () => {
  it("keeps the primary lane and normalizes custodied namespaces", () => {
    expect(
      workerNamespaces(
        "cogni-production",
        " cogni-candidate-a, cogni-preview,cogni-preview, "
      )
    ).toEqual(["cogni-production", "cogni-candidate-a", "cogni-preview"]);
  });

  it("never duplicates the primary namespace", () => {
    expect(
      workerNamespaces("cogni-production", "cogni-production,cogni-candidate-a")
    ).toEqual(["cogni-production", "cogni-candidate-a"]);
  });
});
