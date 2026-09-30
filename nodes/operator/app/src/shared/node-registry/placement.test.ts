// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/placement` (test)
 * Purpose: Pin PLACEMENT_DECIDES_THE_ADDRESS — an akash-placed node resolves to its OFF-CLUSTER
 *   public address and a k3s-placed node keeps resolving to in-cluster Service DNS (bug.5106).
 * Scope: Pure unit test; no network, no DB, no env.
 * Invariants: K3S_IS_DEFAULT, OFF_CLUSTER_ADDRESS_IS_THE_PUBLIC_HOST, FAIL_LOUD_WITHOUT_A_DOMAIN.
 * Side-effects: none
 * Links: src/shared/node-registry/placement.ts, bug.5106
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  controlEnvFor,
  nodeAppBaseUrl,
  providerForEnv,
  substrateHostEnvFor,
  toNodeDeploymentPlacement,
} from "./placement";

describe("controlEnvFor", () => {
  it("routes external lanes through the configured fleet control env", () => {
    expect(controlEnvFor("preview", "akash", "candidate-a")).toBe(
      "candidate-a"
    );
    expect(controlEnvFor("preview", "k3s", "candidate-a")).toBe("preview");
  });
});

describe("providerForEnv", () => {
  it("defaults an undeclared environment to k3s (K3S_IS_DEFAULT)", () => {
    expect(providerForEnv(undefined, "production")).toBe("k3s");
    expect(providerForEnv({}, "candidate-a")).toBe("k3s");
    expect(providerForEnv({ preview: "akash" }, "production")).toBe("k3s");
  });

  it("reads the declared provider for the environment doing the dialing", () => {
    const placement = {
      "candidate-a": "akash",
      preview: "akash",
      production: "k3s",
    } as const;
    expect(providerForEnv(placement, "candidate-a")).toBe("akash");
    expect(providerForEnv(placement, "production")).toBe("k3s");
  });
});

describe("toNodeDeploymentPlacement", () => {
  it("keeps declared entries and drops anything outside the vocabulary", () => {
    expect(
      toNodeDeploymentPlacement({
        "candidate-a": "akash",
        staging: "akash",
        production: "console",
      })
    ).toEqual({ "candidate-a": "akash" });
  });

  it("degrades a non-object projection to the empty (all-k3s) map", () => {
    expect(toNodeDeploymentPlacement(null)).toEqual({});
    expect(toNodeDeploymentPlacement("akash")).toEqual({});
    expect(toNodeDeploymentPlacement(["akash"])).toEqual({});
  });
});

describe("nodeAppBaseUrl", () => {
  it("resolves a k3s-placed node to in-cluster Service DNS", () => {
    expect(
      nodeAppBaseUrl({
        slug: "blue",
        provider: "k3s",
        environment: "production",
        apexDomain: "cognidao.org",
      })
    ).toBe("http://blue-node-app:3000");
  });

  it("resolves a k3s-placed node without any domain configured", () => {
    expect(
      nodeAppBaseUrl({
        slug: "blue",
        provider: "k3s",
        environment: "candidate-a",
      })
    ).toBe("http://blue-node-app:3000");
  });

  it("resolves an akash-placed node to its EXTERNAL public host, per env", () => {
    // The operator's own apex carries the env prefix; rootDomain strips it so the per-env host
    // convention is applied exactly once (never `toks4-test.test.cognidao.org`).
    expect(
      nodeAppBaseUrl({
        slug: "toks4",
        provider: "akash",
        environment: "candidate-a",
        apexDomain: "test.cognidao.org",
      })
    ).toBe("https://toks4-test.cognidao.org");

    expect(
      nodeAppBaseUrl({
        slug: "toks4",
        provider: "akash",
        environment: "preview",
        apexDomain: "preview.cognidao.org",
      })
    ).toBe("https://toks4-preview.cognidao.org");

    expect(
      nodeAppBaseUrl({
        slug: "toks4",
        provider: "akash",
        environment: "production",
        apexDomain: "cognidao.org",
      })
    ).toBe("https://toks4.cognidao.org");
  });

  it("throws rather than silently falling back to unresolvable in-cluster DNS", () => {
    expect(() =>
      nodeAppBaseUrl({
        slug: "toks4",
        provider: "akash",
        environment: "candidate-a",
      })
    ).toThrow(/no base domain is configured/);
  });
});

describe("controlEnvFor (bug.5204/bug.5235 — FLEET_CONTROL_ENV twin of appset-paths.sh)", () => {
  it("keeps production reconciled by production regardless of provider or fleet control env", () => {
    expect(controlEnvFor("production", "akash")).toBe("production");
    expect(controlEnvFor("production", "k3s")).toBe("production");
    expect(controlEnvFor("production", "akash", "candidate-a")).toBe(
      "production"
    );
  });

  it("keeps a k3s lane reconciled by its own env — placement must be stated to move it", () => {
    expect(controlEnvFor("candidate-a", "k3s")).toBe("candidate-a");
    expect(controlEnvFor("preview", "k3s")).toBe("preview");
    // The fleet control env is IRRELEVANT for a k3s lane: it runs IN its own cluster.
    expect(controlEnvFor("candidate-a", "k3s", "candidate-a")).toBe(
      "candidate-a"
    );
  });

  it("defaults an akash non-production lane to production when no fleet control env is given (cogni-dao, byte-identical)", () => {
    expect(controlEnvFor("candidate-a", "akash")).toBe("production");
    expect(controlEnvFor("preview", "akash")).toBe("production");
    // An empty/whitespace value is treated as unset — still the production default.
    expect(controlEnvFor("candidate-a", "akash", "")).toBe("production");
    expect(controlEnvFor("candidate-a", "akash", "   ")).toBe("production");
  });

  it("reconciles an akash non-production lane by the FLEET CONTROL ENV on an isolated fleet", () => {
    // cogni-test-org exports FLEET_CONTROL_ENV=candidate-a — its OWN control plane reconciles +
    // pays for akash lanes, so the AppSet dir is appsets/candidate-a/, not appsets/production/.
    expect(controlEnvFor("candidate-a", "akash", "candidate-a")).toBe(
      "candidate-a"
    );
    expect(controlEnvFor("preview", "akash", "candidate-a")).toBe(
      "candidate-a"
    );
    expect(controlEnvFor("candidate-a", "akash", " candidate-a ")).toBe(
      "candidate-a"
    );
  });
});

describe("substrateHostEnvFor — the third axis (bug.5299)", () => {
  it("is INERT when the cell is absent: identical to controlEnvFor for every lane/provider", () => {
    for (const env of ["candidate-a", "preview", "production"] as const) {
      for (const provider of ["k3s", "akash"] as const) {
        expect(substrateHostEnvFor(env, provider)).toBe(
          controlEnvFor(env, provider)
        );
        // and on an isolated fleet
        expect(
          substrateHostEnvFor(env, provider, undefined, "candidate-a")
        ).toBe(controlEnvFor(env, provider, "candidate-a"));
      }
    }
  });

  it("treats empty / whitespace as unset (never as a relocation)", () => {
    expect(substrateHostEnvFor("candidate-a", "akash", "")).toBe("production");
    expect(substrateHostEnvFor("candidate-a", "akash", "   ")).toBe(
      "production"
    );
    expect(substrateHostEnvFor("candidate-a", "akash", undefined)).toBe(
      "production"
    );
  });

  it("relocates the DB host to the stated env while the CONTROL env stays put", () => {
    // This is the whole point: the database leaves the production host, but payment and the
    // lease do not move — controlEnvFor is unchanged for the same lane.
    expect(substrateHostEnvFor("candidate-a", "akash", "candidate-a")).toBe(
      "candidate-a"
    );
    expect(controlEnvFor("candidate-a", "akash")).toBe("production");

    expect(substrateHostEnvFor("preview", "akash", "preview")).toBe("preview");
    expect(controlEnvFor("preview", "akash")).toBe("production");
  });

  it("FAILS CLOSED on a malformed cell — a typo must never silently mean 'the control env'", () => {
    expect(() =>
      substrateHostEnvFor("candidate-a", "akash", "staging")
    ).toThrow(/invalid substrate_host_env 'staging'/);
    expect(() =>
      substrateHostEnvFor("candidate-a", "akash", "PRODUCTION")
    ).toThrow(/invalid substrate_host_env/);
  });
});
