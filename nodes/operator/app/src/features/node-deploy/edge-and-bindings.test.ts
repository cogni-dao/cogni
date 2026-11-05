// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/edge-and-bindings.test`
 * Purpose: Pin the edge guards (host regex, adopt-by-name, proxied required, never self-point,
 *   readback, no delete) and `resolveBinding` (task.5400).
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import { forwardedTcpEndpoint, resolveBinding } from "./bindings";
import {
  EdgeGuardError,
  EdgeRouter,
  edgeHostRegexFor,
  hostOwnedBy,
} from "./edge";
import { ingressHostOf } from "./spec";
import { FakeDns, WORKLOAD_ZONE } from "./testing";

const DEFAULT_EDGE_HOST_REGEX = edgeHostRegexFor([], WORKLOAD_ZONE);

describe("resolveBinding", () => {
  const consumer = {
    bindings: [
      { env: "DATABASE_URL", workload: "canary-db" },
      { env: "OTHER_URL", workload: "elsewhere" },
    ],
  };

  it("builds DATABASE_URL from the state lease's forwarded port and the stored password", () => {
    const [b] = resolveBinding(consumer, {
      name: "canary-db",
      endpoints: ["tcp://provider.example.com:31337"],
      password: "p@ss/w+rd",
    });
    expect(b).toEqual({
      env: "DATABASE_URL",
      value:
        "postgres://postgres:p%40ss%2Fw%2Brd@provider.example.com:31337/postgres?sslmode=require",
      host: "provider.example.com",
      port: 31337,
    });
  });

  it("ignores bindings that target another workload", () => {
    expect(
      resolveBinding(consumer, { name: "nobody", endpoints: [], password: "x" })
    ).toEqual([]);
  });

  it("refuses zero or several forwarded tcp endpoints instead of guessing", () => {
    expect(() => forwardedTcpEndpoint(["host.example"])).toThrow(/exactly one/);
    expect(() =>
      forwardedTcpEndpoint(["tcp://a.example:1", "tcp://b.example:2"])
    ).toThrow(/exactly one/);
    expect(() => forwardedTcpEndpoint(["tcp://a.example:99999"])).toThrow(
      /range/
    );
  });
});

describe("EdgeRouter guards", () => {
  const HOST = "node-deploy-canary.cognidao.org";

  it("default regex admits the canary hosts and nothing else", () => {
    for (const ok of [
      "node-deploy-canary.cognidao.org",
      "node-deploy-canary-test.cognidao.org",
      "node-deploy-canary-preview.cognidao.org",
      "node-deploy-canary-dev.cognidao.org",
    ])
      expect(DEFAULT_EDGE_HOST_REGEX.test(ok)).toBe(true);
    for (const bad of [
      "cognidao.org",
      "www.cognidao.org",
      "poly.cognidao.org",
      "node-deploy-canary.cognidao.org.evil.com",
      "evil-node-deploy-canary.cognidao.org",
      "node-deploy-canary-x1.cognidao.org",
    ])
      expect(DEFAULT_EDGE_HOST_REGEX.test(bad)).toBe(false);
  });

  it("a catalog-built regex admits the canary and each listed node (with env suffixes) and nothing else", () => {
    const re = edgeHostRegexFor(
      ["poly", "node-template", "toks5", "operator"],
      WORKLOAD_ZONE
    );
    for (const ok of [
      "node-deploy-canary.cognidao.org",
      "poly.cognidao.org",
      "poly-test.cognidao.org",
      "node-template.cognidao.org",
      "node-template-preview.cognidao.org",
      "toks5-test.cognidao.org",
    ])
      expect(re.test(ok), ok).toBe(true);
    for (const bad of [
      "cognidao.org",
      "preview.cognidao.org",
      "test.cognidao.org",
      "www.cognidao.org",
      "beacon.cognidao.org", // a crossplane node is not listed
      "red-test.cognidao.org",
      "poly.cognidao.org.evil.com",
      "evilpoly.cognidao.org",
      "poly-x1.cognidao.org",
      "operator.cognidao.org",
    ])
      expect(re.test(bad), bad).toBe(false);
    // slugs are escaped, not interpreted as a pattern
    expect(
      edgeHostRegexFor(["a.b"], WORKLOAD_ZONE).test("axb.cognidao.org")
    ).toBe(false);
  });

  it("a sibling workload host <slug>-<workload>[-env] passes the guard only for a listed node (task.5272)", () => {
    const re = edgeHostRegexFor(["red"], WORKLOAD_ZONE);
    for (const ok of [
      "red-sandbox.cognidao.org",
      "red-sandbox-test.cognidao.org",
      "red-sandbox-preview.cognidao.org",
    ])
      expect(re.test(ok), ok).toBe(true);
    for (const bad of [
      "red-sandbox-a-b.cognidao.org",
      "red-sandbox-x1.cognidao.org",
      "poly-sandbox.cognidao.org",
      "red-sandbox.cognidao.org.evil.com",
    ])
      expect(re.test(bad), bad).toBe(false);
  });

  it("hostOwnedBy with a workload: <slug>-<workload> plus the env suffix, never another node's or the operator's", () => {
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red-sandbox.cognidao.org",
        "production",
        "red",
        "sandbox"
      )
    ).toBe(true);
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red-sandbox-test.cognidao.org",
        "candidate-a",
        "red",
        "sandbox"
      )
    ).toBe(true);
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red-sandbox-preview.cognidao.org",
        "preview",
        "red",
        "sandbox"
      )
    ).toBe(true);
    // the node's own host stays claimable by any of its workloads
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red.cognidao.org",
        "production",
        "red",
        "sandbox"
      )
    ).toBe(true);
    // a workload cannot claim another workload's host, another env's host, or another node's
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red-other.cognidao.org",
        "production",
        "red",
        "sandbox"
      )
    ).toBe(false);
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red-sandbox.cognidao.org",
        "candidate-a",
        "red",
        "sandbox"
      )
    ).toBe(false);
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red-sandbox.cognidao.org",
        "production",
        "poly",
        "sandbox"
      )
    ).toBe(false);
    // the operator owns only its canary: a workload name never widens it
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "node-deploy-canary-sandbox.cognidao.org",
        "production",
        "operator",
        "sandbox"
      )
    ).toBe(false);
    // without a workload the old behaviour holds exactly
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "red-sandbox.cognidao.org",
        "production",
        "red"
      )
    ).toBe(false);
  });

  it("hostOwnedBy: a node owns exactly its own host in each env; the operator owns the canary", () => {
    expect(
      hostOwnedBy(WORKLOAD_ZONE, "poly.cognidao.org", "production", "poly")
    ).toBe(true);
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "poly-test.cognidao.org",
        "candidate-a",
        "poly"
      )
    ).toBe(true);
    expect(
      hostOwnedBy(WORKLOAD_ZONE, "poly-preview.cognidao.org", "preview", "poly")
    ).toBe(true);
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "node-deploy-canary.cognidao.org",
        "production",
        "operator"
      )
    ).toBe(true);
    // node A cannot claim node B's host, or another env's host for itself
    expect(
      hostOwnedBy(WORKLOAD_ZONE, "toks5.cognidao.org", "production", "poly")
    ).toBe(false);
    expect(
      hostOwnedBy(WORKLOAD_ZONE, "poly.cognidao.org", "production", "toks5")
    ).toBe(false);
    expect(
      hostOwnedBy(WORKLOAD_ZONE, "poly.cognidao.org", "candidate-a", "poly")
    ).toBe(false);
    // "poly-test" the node's production host collides with "poly" candidate-a: only the exact owner wins
    expect(
      hostOwnedBy(WORKLOAD_ZONE, "poly-test.cognidao.org", "production", "poly")
    ).toBe(false);
    // operator hosts are never claimable by a node
    for (const host of [
      "cognidao.org",
      "preview.cognidao.org",
      "test.cognidao.org",
    ])
      expect(hostOwnedBy(WORKLOAD_ZONE, host, "production", "poly")).toBe(
        false
      );
    expect(
      hostOwnedBy(
        WORKLOAD_ZONE,
        "node-deploy-canary.cognidao.org",
        "production",
        "poly"
      )
    ).toBe(false);
    expect(
      hostOwnedBy(WORKLOAD_ZONE, "poly.cognidao.org", "mars", "poly")
    ).toBe(false);
  });

  it("refuses an unguarded host before any request is made", async () => {
    const dns = new FakeDns([]);
    const edge = new EdgeRouter(dns, WORKLOAD_ZONE);
    await expect(
      edge.point("poly.cognidao.org", "x.example")
    ).rejects.toBeInstanceOf(EdgeGuardError);
    await expect(edge.current("poly.cognidao.org")).rejects.toBeInstanceOf(
      EdgeGuardError
    );
    expect(dns.ops).toEqual([]);
  });

  it("creates a proxied CNAME and reads it back", async () => {
    const dns = new FakeDns([]);
    const rec = await new EdgeRouter(dns, WORKLOAD_ZONE).point(
      HOST,
      "Ingress.Provider.Example."
    );
    expect(rec).toMatchObject({
      name: HOST,
      type: "CNAME",
      content: "ingress.provider.example",
      proxied: true,
    });
    expect(dns.ops).toEqual([`create:${HOST}->ingress.provider.example`]);
  });

  it("ADOPTS an existing record by name, whatever its type, and updates it in place", async () => {
    const dns = new FakeDns([]);
    const seeded = dns.seed({
      name: HOST,
      type: "A",
      content: "203.0.113.9",
      proxied: false,
    });
    const rec = await new EdgeRouter(dns, WORKLOAD_ZONE).point(
      HOST,
      "ingress.provider.example"
    );
    expect(rec.id).toBe(seeded.id);
    expect(rec.type).toBe("CNAME");
    expect(rec.proxied).toBe(true);
    expect(dns.records.size).toBe(1);
    expect(dns.ops[0]).toMatch(/^update:/);
  });

  it("refuses two records of one name rather than choosing", async () => {
    const dns = new FakeDns([]);
    dns.seed({ name: HOST, type: "A", content: "1.1.1.1", proxied: true });
    dns.seed({
      name: HOST,
      type: "CNAME",
      content: "x.example",
      proxied: true,
    });
    await expect(
      new EdgeRouter(dns, WORKLOAD_ZONE).point(HOST, "y.example")
    ).rejects.toThrow(/refusing to choose/);
  });

  it("never points a host at itself", async () => {
    await expect(
      new EdgeRouter(new FakeDns([]), WORKLOAD_ZONE).point(HOST, HOST)
    ).rejects.toThrow(/itself/);
  });

  it("requires proxied=true on the readback", async () => {
    const dns = new FakeDns([]);
    dns.corruptReadback = true;
    await expect(
      new EdgeRouter(dns, WORKLOAD_ZONE).point(HOST, "y.example")
    ).rejects.toThrow(/readback mismatch/);
  });

  it("has no way to withdraw a record: the port exposes no delete", () => {
    const dns = new FakeDns([]) as unknown as Record<string, unknown>;
    expect(dns.delete).toBeUndefined();
    expect(dns.remove).toBeUndefined();
  });
});

describe("ingressHostOf", () => {
  it("picks the provider ingress, not the public host or a forwarded port", () => {
    expect(
      ingressHostOf(
        [
          "tcp://p.example:3000",
          "https://abc.ingress.p.example/",
          "pub.example.org",
        ],
        "pub.example.org"
      )
    ).toBe("abc.ingress.p.example");
    expect(
      ingressHostOf(["pub.example.org"], "pub.example.org")
    ).toBeUndefined();
  });
});
