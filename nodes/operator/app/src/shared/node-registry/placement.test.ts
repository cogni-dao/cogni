// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/placement` (test)
 * Purpose: Pin PLACEMENT_DECIDES_THE_ADDRESS — an akash-placed node resolves to its EXTERNAL
 *   public address and a k3s-placed node keeps resolving to in-cluster Service DNS (bug.5106).
 * Scope: Pure unit test; no network, no DB, no env.
 * Invariants: K3S_IS_DEFAULT, EXTERNAL_ADDRESS_IS_THE_PUBLIC_HOST, FAIL_LOUD_WITHOUT_A_DOMAIN.
 * Side-effects: none
 * Links: src/shared/node-registry/placement.ts, bug.5106
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  nodeAppBaseUrl,
  providerForEnv,
  toNodeDeploymentPlacement,
} from "./placement";

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
