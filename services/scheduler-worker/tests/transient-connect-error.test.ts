// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/transient-connect-error.test`
 * Purpose: Unit tests for the retry predicate that decides whether a Temporal
 *   `NativeConnection.connect` failure is a transient DNS/transport blip
 *   (retry) or a permanent error (rethrow). A transient name-resolution blip at
 *   boot crashlooped the pod and storm-degraded the shared k3s VM → fleet 502
 *   (incident 2026-06-30); this predicate is the load-bearing decision.
 * Scope: Pure function only; no Temporal connection or worker setup.
 * @internal
 */

import { describe, expect, it } from "vitest";

import { isTransientConnectError } from "../src/worker.js";

describe("isTransientConnectError", () => {
  it("retries the prod fleet-502 transient DNS failure", () => {
    // The exact shape that took the fleet down on 2026-06-30.
    const err = Object.assign(
      new Error('dns error", "Temporary failure in name resolution'),
      {
        name: "TransportError",
      }
    );
    expect(isTransientConnectError(err)).toBe(true);
  });

  it("retries on the TransportError type regardless of message", () => {
    const err = Object.assign(new Error("tonic::transport ConnectError"), {
      name: "TransportError",
    });
    expect(isTransientConnectError(err)).toBe(true);
  });

  it("retries on transient message markers", () => {
    for (const message of [
      "getaddrinfo ENOTFOUND cogni.vm.cognidao.org",
      "getaddrinfo EAI_AGAIN cogni.vm.cognidao.org",
      "Connection refused (os error 111)",
      "status: UNAVAILABLE",
      "ConnectError: failed to connect",
      "Temporary failure in name resolution",
    ]) {
      expect(isTransientConnectError(new Error(message))).toBe(true);
    }
  });

  it("retries when the transient marker is on the error code", () => {
    const err = Object.assign(new Error("lookup failed"), {
      code: "EAI_AGAIN",
    });
    expect(isTransientConnectError(err)).toBe(true);
  });

  it("does NOT retry a permanent/non-transient error", () => {
    expect(isTransientConnectError(new Error("invalid namespace"))).toBe(false);
    expect(isTransientConnectError(new Error("permission denied"))).toBe(false);
  });

  it("is null/undefined-safe", () => {
    expect(isTransientConnectError(null)).toBe(false);
    expect(isTransientConnectError(undefined)).toBe(false);
    expect(isTransientConnectError("just a string")).toBe(false);
  });
});
