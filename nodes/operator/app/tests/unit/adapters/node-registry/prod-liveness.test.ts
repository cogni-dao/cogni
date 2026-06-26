// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@adapters/server/node-registry/prod-liveness`.
 * Purpose: Pin the cross-node liveness+identity rollup — env-scoped host derivation, "pass ⇒ live" /
 *   non-pass ⇒ down, identity read alongside liveness in one pass, per-node degrade (a thrown probe ⇒
 *   {down, null} for that slug only), and that the map key set equals the candidate set (not filtered).
 * Scope: Pure logic with a fake NodeProber (no network).
 * Side-effects: none
 * Links: src/adapters/server/node-registry/prod-liveness.ts
 */

import { describe, expect, it, vi } from "vitest";
import { resolveNodeLiveness } from "@/adapters/server/node-registry/prod-liveness";
import type { NodeIdentity, NodeProber, ServingResult } from "@/ports";
import { envForApex } from "@/shared/node-registry/deploy-hosts";

describe("envForApex (operator self-env)", () => {
  it("maps the apex subdomain to the operator's own deploy env", () => {
    expect(envForApex("test.cognidao.org")).toBe("candidate-a");
    expect(envForApex("preview.cognidao.org")).toBe("preview");
    expect(envForApex("cognidao.org")).toBe("production");
  });
});

const CONFIG = {
  baseDomain: "cognidao.org",
  primarySlug: "operator",
  env: "production",
} as const;

function identityFor(host: string): NodeIdentity {
  return {
    name: host.split(".")[0] ?? host,
    hook: `${host} hook`,
    mission: `${host} mission`,
    brand: {
      icon: null,
      thumbnail: `https://${host}/showcase/x.png`,
      color: "#abc",
    },
  };
}

/**
 * Fake prober: per-host serving verdict from a map; missing host ⇒ fail. Identity echoes the host, but
 * ONLY for hosts that serve (`pass`) — a dead host's well-known is also unreachable ⇒ null identity. This
 * models the common case while still proving serving + identity are independent (see the dedicated
 * "thrown identity probe still yields health" test for the independence edge).
 */
function proberFromHosts(
  byHost: Record<string, ServingResult["status"]>,
  onCall?: (host: string) => void
): NodeProber {
  return {
    serving: async (host: string) => {
      onCall?.(host);
      const status = byHost[host] ?? "fail";
      return {
        status,
        readyzCode: status === "pass" ? 200 : 525,
        buildSha: null,
      };
    },
    runCarries: async () => ({
      status: "fail",
      durationMs: 0,
      runs: 0,
      detail: "unused",
    }),
    identity: async (host: string) =>
      byHost[host] === "pass" ? identityFor(host) : null,
  };
}

describe("resolveNodeLiveness", () => {
  it("derives the prod host per slug, maps pass⇒live / non-pass⇒down, and attaches identity", async () => {
    const calledHosts: string[] = [];
    const prober = proberFromHosts(
      {
        "cognidao.org": "pass", // operator = primary ⇒ bare apex
        "node-template.cognidao.org": "pass",
        "resy.cognidao.org": "fail", // 525 edge ⇒ down
      },
      (h) => calledHosts.push(h)
    );

    const live = await resolveNodeLiveness(
      ["operator", "resy", "node-template"],
      { prober, config: CONFIG }
    );

    expect(live.get("operator")?.health).toBe("live");
    expect(live.get("node-template")?.health).toBe("live");
    expect(live.get("resy")?.health).toBe("down");
    // identity is read for the live hosts; the dead resy host returns null from the fake.
    expect(live.get("operator")?.identity?.hook).toBe("cognidao.org hook");
    expect(live.get("resy")?.identity).toBeNull();
    // operator probed at the bare apex, others at the slugged prod host.
    expect(calledHosts).toContain("cognidao.org");
    expect(calledHosts).toContain("node-template.cognidao.org");
  });

  it("returns ALL candidate slugs (does NOT filter down nodes)", async () => {
    const prober = proberFromHosts({ "cognidao.org": "pass" });
    const live = await resolveNodeLiveness(["operator", "resy"], {
      prober,
      config: CONFIG,
    });
    expect([...live.keys()].sort()).toEqual(["operator", "resy"]);
    expect(live.get("resy")?.health).toBe("down");
  });

  it("ENV_SCOPED_VIEW: a candidate-a operator probes the -test hosts, not prod", async () => {
    const calledHosts: string[] = [];
    const prober = proberFromHosts(
      {
        "test.cognidao.org": "pass", // operator (primary) test apex
        "beacon-test.cognidao.org": "pass", // non-primary slugged test host
      },
      (h) => calledHosts.push(h)
    );

    const live = await resolveNodeLiveness(["operator", "beacon"], {
      prober,
      config: { ...CONFIG, env: "candidate-a" },
    });

    expect(live.get("operator")?.health).toBe("live");
    expect(live.get("beacon")?.health).toBe("live");
    expect(calledHosts).toContain("test.cognidao.org");
    expect(calledHosts).toContain("beacon-test.cognidao.org");
    expect(calledHosts).not.toContain("cognidao.org"); // never the prod apex
  });

  it("degrades per-node: a thrown serving probe ⇒ {down, identity} for only that slug", async () => {
    const prober: NodeProber = {
      serving: async (host: string) => {
        if (host === "resy.cognidao.org") throw new Error("network down");
        return { status: "pass", readyzCode: 200, buildSha: null };
      },
      runCarries: async () => ({
        status: "fail",
        durationMs: 0,
        runs: 0,
        detail: "unused",
      }),
      identity: async () => null,
    };

    const live = await resolveNodeLiveness(["operator", "resy"], {
      prober,
      config: CONFIG,
    });

    expect(live.get("operator")?.health).toBe("live");
    expect(live.get("resy")?.health).toBe("down");
  });

  it("a thrown identity probe still yields health (identity is independent)", async () => {
    const prober: NodeProber = {
      serving: async () => ({
        status: "pass",
        readyzCode: 200,
        buildSha: null,
      }),
      runCarries: async () => ({
        status: "fail",
        durationMs: 0,
        runs: 0,
        detail: "unused",
      }),
      identity: async () => {
        throw new Error("well-known unreachable");
      },
    };
    const live = await resolveNodeLiveness(["operator"], {
      prober,
      config: CONFIG,
    });
    expect(live.get("operator")).toEqual({ health: "live", identity: null });
  });

  it("empty candidate set ⇒ empty map, no probes", async () => {
    const serving = vi.fn();
    const prober = proberFromHosts({}, serving);
    const live = await resolveNodeLiveness([], { prober, config: CONFIG });
    expect(live.size).toBe(0);
    expect(serving).not.toHaveBeenCalled();
  });

  it("dedupes candidate slugs before probing", async () => {
    const serving = vi.fn((_h: string) => {});
    const prober = proberFromHosts({ "cognidao.org": "pass" }, serving);
    const live = await resolveNodeLiveness(
      ["operator", "operator", "operator"],
      {
        prober,
        config: CONFIG,
      }
    );
    expect([...live.keys()]).toEqual(["operator"]);
    expect(serving).toHaveBeenCalledTimes(1);
  });
});
