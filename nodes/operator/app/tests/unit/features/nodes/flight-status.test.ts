// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests for `@features/nodes/flight-status` + the prober classifier.
 * Purpose: Pin the substrate-verification-gate logic: host derivation, root-zone stripping, the
 *   exact node/env probe targeting and serving→run-carries short-circuit.
 * Scope: Pure logic only — the verifier is exercised with a fake prober (no network/db).
 * Side-effects: none
 * Links: src/features/nodes/flight-status.ts, src/adapters/server/node-flight/node-prober.adapter.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  assertLive,
  hostForEnv,
  rootDomain,
  verifyFlightStatus,
} from "@/features/nodes/flight-status";
import type { NodeProber, RunCarriesResult, ServingResult } from "@/ports";

/** Build a fake NodeProber; both rungs default to pass-ish, override per test. */
function makeProber(o: Partial<NodeProber> = {}): NodeProber {
  return {
    serving: async () => ({ status: "pass", readyzCode: 200, buildSha: "abc" }),
    runCarries: async () => ({
      status: "pass",
      durationMs: 1,
      runs: 1,
      detail: "probe-complete",
    }),
    identity: async () => null,
    ...o,
  };
}

describe("hostForEnv", () => {
  it("prefixes non-primary nodes per env, bare on prod", () => {
    expect(hostForEnv("beacon", false, "candidate-a", "cognidao.org")).toBe(
      "beacon-test.cognidao.org"
    );
    expect(hostForEnv("beacon", false, "preview", "cognidao.org")).toBe(
      "beacon-preview.cognidao.org"
    );
    expect(hostForEnv("beacon", false, "production", "cognidao.org")).toBe(
      "beacon.cognidao.org"
    );
  });

  it("serves the env apex for the primary (operator)", () => {
    expect(hostForEnv("operator", true, "candidate-a", "cognidao.org")).toBe(
      "test.cognidao.org"
    );
    expect(hostForEnv("operator", true, "preview", "cognidao.org")).toBe(
      "preview.cognidao.org"
    );
    expect(hostForEnv("operator", true, "production", "cognidao.org")).toBe(
      "cognidao.org"
    );
  });
});

describe("rootDomain", () => {
  it("strips a leading env subdomain to the root zone", () => {
    expect(rootDomain("test.cognidao.org")).toBe("cognidao.org");
    expect(rootDomain("preview.cognidao.org")).toBe("cognidao.org");
    expect(rootDomain("cognidao.org")).toBe("cognidao.org");
  });
});

describe("verifyFlightStatus", () => {
  const serving = (status: ServingResult["status"]): ServingResult => ({
    status,
    readyzCode: status === "pass" ? 200 : 525,
    buildSha: status === "pass" ? "abc123" : null,
  });
  const carry = (status: RunCarriesResult["status"]): RunCarriesResult => ({
    status,
    durationMs: 2000,
    runs: status === "fail" ? 0 : 1,
    detail: status,
  });

  it("skips run-carries when serving fails (no chat probe against a 525 edge)", async () => {
    const prober = makeProber({
      serving: async () => serving("fail"),
      runCarries: async () => carry("pass"),
    });
    const r = await verifyFlightStatus(
      {
        nodeId: "n1",
        slug: "beacon",
        primary: false,
        baseDomain: "cognidao.org",
      },
      prober
    );
    expect(r.envs.every((e) => e.runCarries.status === "skip")).toBe(true);
    expect(r.allEnvsCarry).toBe(false);
  });

  it("allEnvsCarry is true when every env passes or degrades", async () => {
    const prober = makeProber({ runCarries: async () => carry("degraded") });
    const r = await verifyFlightStatus(
      {
        nodeId: "n1",
        slug: "beacon",
        primary: false,
        baseDomain: "cognidao.org",
      },
      prober
    );
    expect(r.allEnvsCarry).toBe(true);
    expect(r.envs).toHaveLength(3);
  });

  it("selects the exact node and environment for every credential lookup", async () => {
    const runCarries = vi.fn(async () => carry("pass"));
    await verifyFlightStatus(
      {
        nodeId: "node-uuid",
        slug: "beacon",
        primary: false,
        baseDomain: "cognidao.org",
      },
      makeProber({ runCarries })
    );
    expect(runCarries).toHaveBeenCalledWith({
      nodeId: "node-uuid",
      env: "candidate-a",
      host: "beacon-test.cognidao.org",
    });
    expect(runCarries).toHaveBeenCalledWith({
      nodeId: "node-uuid",
      env: "preview",
      host: "beacon-preview.cognidao.org",
    });
    expect(runCarries).toHaveBeenCalledWith({
      nodeId: "node-uuid",
      env: "production",
      host: "beacon.cognidao.org",
    });
  });
});

describe("assertLive (fail-loud live gate)", () => {
  const args = {
    slug: "beacon",
    nodeId: "uuid-1",
    primary: false,
    env: "production" as const,
    baseDomain: "cognidao.org",
  };

  it("is live when both public rungs pass", async () => {
    const r = await assertLive(args, makeProber());
    expect(r.live).toBe(true);
    expect(r.failures).toHaveLength(0);
    expect(r.host).toBe("beacon.cognidao.org");
  });

  it("a dead run-carries blocks (the bug.5021 hang — no run created)", async () => {
    const r = await assertLive(
      args,
      makeProber({
        serving: async () => ({
          status: "pass",
          readyzCode: 200,
          buildSha: "x",
        }),
        runCarries: async () => ({
          status: "fail",
          durationMs: 60_000,
          runs: 0,
          detail: "hang:no-run",
        }),
      })
    );
    expect(r.live).toBe(false);
    expect(r.failures.some((f) => f.includes("run-carries"))).toBe(true);
  });

  it("fails closed before probing when the registry has no node ID", async () => {
    const runCarries = vi.fn();
    const r = await assertLive(
      { ...args, nodeId: undefined },
      makeProber({ runCarries })
    );
    expect(r.live).toBe(false);
    expect(r.probes.runCarries.detail).toBe("probe-node-id-missing");
    expect(runCarries).not.toHaveBeenCalled();
  });
});
