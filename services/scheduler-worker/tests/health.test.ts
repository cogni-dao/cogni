// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/health`
 * Purpose: Prove the Temporal poller identity binds exact worker artifacts.
 * Scope: Pure identity formatting; no HTTP server or Temporal connection.
 * Side-effects: none
 * Links: task.5238
 * @internal
 */

import { describe, expect, it } from "vitest";

import { schedulerWorkerPollerIdentity } from "../src/health.js";

describe("schedulerWorkerPollerIdentity", () => {
  it("binds the exact source SHA and normalized immutable digest", () => {
    expect(
      schedulerWorkerPollerIdentity({
        service: "scheduler-worker",
        sha: "a".repeat(40),
        buildTs: "2026-10-11T00:00:00Z",
        imageDigest: `ghcr.io/cogni-dao/cogni@sha256:${"b".repeat(64)}`,
      })
    ).toBe(`cogni:scheduler-worker:${"a".repeat(40)}:sha256:${"b".repeat(64)}`);
  });

  it("uses a fail-closed sentinel for invalid artifact metadata", () => {
    expect(
      schedulerWorkerPollerIdentity({
        service: "scheduler-worker",
        sha: "unknown",
        buildTs: "unknown",
        imageDigest: "placeholder",
      })
    ).toBe("cogni:scheduler-worker:invalid");
  });
});
