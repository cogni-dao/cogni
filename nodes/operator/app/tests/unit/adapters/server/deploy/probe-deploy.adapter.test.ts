// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@adapters/server/deploy/probe-deploy`.
 * Purpose: Pin the v0 SEE-flow mapping — one `serving` rung → the coarse `(env,node)` deploy state a
 *   public probe can prove (health, replicas, buildSha), the primary-vs-slugged host derivation, and
 *   the unknown-env short-circuit that must NOT hit the network.
 * Scope: Pure logic with a fake NodeProber (no network, no db).
 * Side-effects: none
 * Links: src/adapters/server/deploy/probe-deploy.adapter.ts
 */

import { describe, expect, it } from "vitest";
import { ProbeDeployAdapter } from "@/adapters/server";
import type { NodeProber, ServingResult } from "@/ports";

const CONFIG = { baseDomain: "cognidao.org", primarySlug: "operator" } as const;

/** A fake prober that records the hosts it was asked to probe. */
function proberReturning(serving: ServingResult): {
  prober: NodeProber;
  hosts: string[];
} {
  const hosts: string[] = [];
  const prober: NodeProber = {
    serving: async (host: string) => {
      hosts.push(host);
      return serving;
    },
    runCarries: async () => ({
      status: "pass",
      durationMs: 1,
      runs: 1,
      detail: "unused",
    }),
    identity: async () => null,
  };
  return { prober, hosts };
}

describe("ProbeDeployAdapter.getDeployState", () => {
  it("maps a serving env to healthy 1/1 and passes buildSha through (sourceSha/digest null)", async () => {
    const { prober, hosts } = proberReturning({
      status: "pass",
      readyzCode: 200,
      buildSha: "deadbee",
    });
    const adapter = new ProbeDeployAdapter(prober, CONFIG);

    const state = await adapter.getDeployState({
      env: "candidate-a",
      node: "beacon",
    });

    expect(state).toMatchObject({
      env: "candidate-a",
      node: "beacon",
      health: "healthy",
      buildSha: "deadbee",
      replicas: { desired: 1, ready: 1 },
      sourceSha: null,
      digest: null,
    });
    // Non-primary node serves the slugged candidate host.
    expect(hosts).toEqual(["beacon-test.cognidao.org"]);
  });

  it("maps a non-serving env to unknown 0/0", async () => {
    const { prober } = proberReturning({
      status: "fail",
      readyzCode: 0,
      buildSha: null,
    });
    const adapter = new ProbeDeployAdapter(prober, CONFIG);

    const state = await adapter.getDeployState({
      env: "production",
      node: "beacon",
    });

    expect(state).toMatchObject({
      health: "unknown",
      replicas: { desired: 0, ready: 0 },
      buildSha: null,
    });
  });

  it("derives the env apex (not a slugged host) for the primary node", async () => {
    const { prober, hosts } = proberReturning({
      status: "pass",
      readyzCode: 200,
      buildSha: "x",
    });
    const adapter = new ProbeDeployAdapter(prober, CONFIG);

    await adapter.getDeployState({ env: "candidate-a", node: "operator" });

    expect(hosts).toEqual(["test.cognidao.org"]);
  });

  it("short-circuits an unknown env to not-deployed WITHOUT probing the network", async () => {
    const { prober, hosts } = proberReturning({
      status: "pass",
      readyzCode: 200,
      buildSha: "x",
    });
    const adapter = new ProbeDeployAdapter(prober, CONFIG);

    const state = await adapter.getDeployState({
      env: "staging",
      node: "beacon",
    });

    expect(state).toMatchObject({
      health: "unknown",
      replicas: { desired: 0, ready: 0 },
    });
    // The unknown env must short-circuit before any network probe.
    expect(hosts).toEqual([]);
  });
});

describe("ProbeDeployAdapter.listEnvironments", () => {
  it("returns the static deploy-env set with an unknown coarse rollup", async () => {
    const { prober } = proberReturning({
      status: "pass",
      readyzCode: 200,
      buildSha: "x",
    });
    const adapter = new ProbeDeployAdapter(prober, CONFIG);

    const envs = await adapter.listEnvironments();

    expect(envs.map((e) => e.env)).toEqual([
      "candidate-a",
      "preview",
      "production",
    ]);
    for (const e of envs) {
      expect(e.nodeCount).toBe(0);
      expect(e.health).toBe("unknown");
    }
  });
});
