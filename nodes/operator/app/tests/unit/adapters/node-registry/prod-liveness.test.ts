// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@adapters/server/node-registry/prod-liveness`.
 * Purpose: Pin the cross-node prod-liveness rollup — production host derivation, "pass ⇒ live",
 *   per-node degrade (a failed/thrown probe excludes that slug only), and concurrency.
 * Scope: Pure logic with a fake NodeProber (no network).
 * Side-effects: none
 * Links: src/adapters/server/node-registry/prod-liveness.ts
 */

import { describe, expect, it, vi } from "vitest";
import { resolveLiveProdSlugs } from "@/adapters/server/node-registry/prod-liveness";
import type { NodeProber, ServingResult } from "@/ports";

const CONFIG = { baseDomain: "cognidao.org", primarySlug: "operator" } as const;

/** Fake prober: per-host serving verdict from a map; missing host ⇒ fail. */
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
  };
}

describe("resolveLiveProdSlugs", () => {
  it("derives the prod host per slug and keeps only passing ones", async () => {
    const calledHosts: string[] = [];
    const prober = proberFromHosts(
      {
        "cognidao.org": "pass", // operator = primary ⇒ bare apex
        "node-template.cognidao.org": "pass",
        "resy.cognidao.org": "fail", // 525 edge ⇒ excluded
      },
      (h) => calledHosts.push(h)
    );

    const live = await resolveLiveProdSlugs(
      ["operator", "resy", "node-template"],
      { prober, config: CONFIG }
    );

    expect([...live].sort()).toEqual(["node-template", "operator"]);
    // Operator probed at the bare apex, others at the slugged prod host.
    expect(calledHosts).toContain("cognidao.org");
    expect(calledHosts).toContain("resy.cognidao.org");
    expect(calledHosts).toContain("node-template.cognidao.org");
  });

  it("degrades per-node: a thrown probe excludes only that slug", async () => {
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
    };

    const live = await resolveLiveProdSlugs(["operator", "resy"], {
      prober,
      config: CONFIG,
    });

    expect([...live]).toEqual(["operator"]);
  });

  it("empty candidate set ⇒ empty live set, no probes", async () => {
    const serving = vi.fn();
    const prober = proberFromHosts({}, serving);
    const live = await resolveLiveProdSlugs([], { prober, config: CONFIG });
    expect(live.size).toBe(0);
    expect(serving).not.toHaveBeenCalled();
  });

  it("dedupes candidate slugs before probing", async () => {
    const serving = vi.fn((_h: string) => {});
    const prober = proberFromHosts({ "cognidao.org": "pass" }, serving);
    const live = await resolveLiveProdSlugs(
      ["operator", "operator", "operator"],
      { prober, config: CONFIG }
    );
    expect([...live]).toEqual(["operator"]);
    expect(serving).toHaveBeenCalledTimes(1);
  });
});
