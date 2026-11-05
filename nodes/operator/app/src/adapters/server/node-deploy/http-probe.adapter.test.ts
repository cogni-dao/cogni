// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/http-probe.adapter.test`
 * Purpose: The public readback resolves a host at its zone's authoritative nameservers, so a public
 *   resolver's cached NXDOMAIN for a brand-new host (story.5137, release 2c7ba767) cannot block it.
 * Scope: Unit; DNS, DoH and the pinned HTTPS GET are injected fakes.
 * @internal
 */

import { EventEmitter } from "node:events";
import { type ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

import type { HttpResult } from "@/ports";

import { HttpProbe, type ProbeDns } from "./http-probe.adapter";

const HOST = "spawny-boi-test.cognidao.org";
const ZONE_NS = ["alice.ns.cloudflare.com", "ian.ns.cloudflare.com"];
const NS_IPS: Record<string, string[]> = {
  "alice.ns.cloudflare.com": ["173.245.58.60"],
  "ian.ns.cloudflare.com": ["173.245.59.118"],
};
const EDGE_IPS = ["104.21.52.57", "172.67.195.242"];

const dnsErr = (code: string) =>
  Object.assign(new Error(`queryA ${code}`), { code });

/**
 * A recursive resolver that cached NXDOMAIN for HOST (the sequencer probed it before the record
 * existed), plus authoritative servers that may already hold the proxied record.
 */
function negativeCachingWorld(opts: { authoritativeHas: boolean }) {
  const recursiveAsked: string[] = [];
  const dns: ProbeDns = {
    ns: vi.fn(async (name: string) => {
      recursiveAsked.push(`NS ${name}`);
      if (name === "cognidao.org") return ZONE_NS;
      throw dnsErr("ENOTFOUND");
    }),
    a: vi.fn(async (name: string, servers?: string[]) => {
      if (servers) {
        expect(servers).toEqual(["173.245.58.60", "173.245.59.118"]);
        if (name === HOST && opts.authoritativeHas) return EDGE_IPS;
        throw dnsErr("ENOTFOUND");
      }
      recursiveAsked.push(`A ${name}`);
      const ips = NS_IPS[name];
      if (ips) return ips;
      throw dnsErr("ENOTFOUND"); // the cached NXDOMAIN
    }),
  };
  // Cloudflare DoH with the same cached NXDOMAIN (Status 3, no Answer).
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 })
  ) as unknown as typeof fetch;
  const gets: { ip: string; host: string; path: string }[] = [];
  const pinnedGet = vi.fn(
    async (ip: string, host: string, path: string): Promise<HttpResult> => {
      gets.push({ ip, host, path });
      return { status: 200, body: '{"buildSha":"abc123"}', ms: 1 };
    }
  );
  const probe = new HttpProbe({ dns, fetchImpl, pinnedGet });
  return { probe, dns, fetchImpl, gets, recursiveAsked };
}

describe("HttpProbe.publicRead (story.5137 NO_NEGATIVE_CACHE)", () => {
  it("reads a new host whose NXDOMAIN a public resolver cached, at the authoritative answer", async () => {
    const w = negativeCachingWorld({ authoritativeHas: true });

    const r = await w.probe.publicRead(HOST, "/version?cb=1");

    expect(r.status).toBe(200);
    expect(r.body).toContain("abc123");
    // The HTTPS read goes to a Cloudflare edge IP with the real Host + SNI.
    expect(w.gets).toEqual([
      { ip: EDGE_IPS[0], host: HOST, path: "/version?cb=1" },
    ]);
    // The negative-caching DoH resolver was never consulted.
    expect(w.fetchImpl).not.toHaveBeenCalled();
    // The new host itself was never sent to a recursive resolver (no new negative cache entry).
    expect(w.recursiveAsked.some((q) => q.endsWith(` ${HOST}`))).toBe(false);
  });

  it("reports no record (no DoH fallback, no read) when the authoritative servers have none", async () => {
    const w = negativeCachingWorld({ authoritativeHas: false });

    const r = await w.probe.publicRead(HOST, "/version");

    expect(r.status).toBe(0);
    expect(r.error).toBe("authoritative: no A record yet");
    expect(w.fetchImpl).not.toHaveBeenCalled();
    expect(w.gets).toEqual([]);
  });

  it("caches the zone nameservers across reads", async () => {
    const w = negativeCachingWorld({ authoritativeHas: true });

    for (let i = 0; i < 8; i++)
      await w.probe.publicRead(HOST, `/version?cb=${i}`);

    expect(w.gets).toHaveLength(8);
    expect(w.dns.ns).toHaveBeenCalledTimes(1);
  });

  it("falls back to DoH when the authoritative path is unreachable, and caches that per zone", async () => {
    const dns: ProbeDns = {
      ns: vi.fn(async () => {
        throw dnsErr("ETIMEOUT");
      }),
      a: vi.fn(async () => {
        throw dnsErr("ETIMEOUT");
      }),
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ Answer: [{ type: 1, data: EDGE_IPS[1] }] }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;
    const pinnedGet = vi.fn(
      async (): Promise<HttpResult> => ({ status: 200, body: "{}", ms: 1 })
    );
    const probe = new HttpProbe({ dns, fetchImpl, pinnedGet });

    const results: HttpResult[] = [];
    for (let i = 0; i < 8; i++)
      results.push(await probe.publicRead(HOST, `/version?cb=${i}`));

    // Every read is served through DoH and says why.
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      results.every((r) => r.fallback === "authoritative queryA ETIMEOUT")
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(pinnedGet).toHaveBeenLastCalledWith(
      EDGE_IPS[1],
      HOST,
      "/version?cb=7"
    );
    // The unreachable authoritative path is paid once, not on each of the 8 reads.
    expect(dns.ns).toHaveBeenCalledTimes(1);
  });

  it("a healthy authoritative read carries no fallback", async () => {
    const w = negativeCachingWorld({ authoritativeHas: true });
    const r = await w.probe.publicRead(HOST, "/version");
    expect(r.fallback).toBeUndefined();
  });
});

vi.mock("node:https", () => ({ request: vi.fn() }));

describe("qualification transport owner reconciliation", () => {
  it.each([
    200, 302, 0,
  ])("verifies observed ingress TLS, selects HTTP Host and refuses redirect/retry (%s)", async (status) => {
    const mock = vi.mocked(httpsRequest);
    mock.mockReset();
    mock.mockImplementation((...args: unknown[]) => {
      const options = args[0] as RequestOptions;
      const callback = args[1];
      expect(options).toMatchObject({
        hostname: "green.provider.example",
        servername: "green.provider.example",
        port: 443,
        method: "POST",
        headers: {
          host: "node-preview.example",
          authorization: "Bearer challenge",
        },
      });
      const opts = options as RequestOptions;
      expect(opts.rejectUnauthorized).not.toBe(false);
      expect(opts.checkServerIdentity).toBeUndefined();
      const req = Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => {
            if (status === 0)
              req.emit("error", new Error("certificate identity mismatch"));
            else {
              const res = new IncomingMessage(new Socket());
              res.statusCode = status;
              res.headers = { location: "https://attacker.invalid" };
              if (typeof callback === "function") callback(res);
              res.push("evidence");
              res.push(null);
            }
            req.emit("close");
          });
          return req;
        },
      });
      return req as unknown as ClientRequest;
    });
    const result = await new HttpProbe().qualification({
      ingressHost: "green.provider.example",
      hostHeader: "node-preview.example",
      path: "/qualification",
      token: "challenge",
      mode: "qualify",
      timeoutMs: 20000,
    });
    expect(result.status).toBe(status);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
