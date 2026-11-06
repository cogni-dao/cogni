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
import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage as ServerIncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const QUALIFY = {
  ingressHost: "green.provider.example",
  path: "/qualification",
  token: "challenge",
  mode: "qualify" as const,
  timeoutMs: 20000,
};

describe("qualification transport owner reconciliation", () => {
  /** The DEFAULT transport: native https with normal verification; the mock fails at connect. */
  function mockHttps(error: Error) {
    const mock = vi.mocked(httpsRequest);
    mock.mockReset();
    mock.mockImplementation((...args: unknown[]) => {
      const options = args[0] as RequestOptions;
      // ONE_AUTHORITY (bug.5568): the observed static ingress is DNS target, SNI and Host.
      expect(options).toMatchObject({
        hostname: "green.provider.example",
        servername: "green.provider.example",
        port: 443,
        method: "POST",
        headers: {
          host: "green.provider.example",
          authorization: "Bearer challenge",
        },
      });
      expect(options.rejectUnauthorized).not.toBe(false);
      expect(options.checkServerIdentity).toBeUndefined();
      expect(options.ca).toBeUndefined();
      const req = Object.assign(new EventEmitter(), {
        destroy() {},
        end() {
          queueMicrotask(() => {
            req.emit("error", error);
            req.emit("close");
          });
          return req;
        },
      });
      return req as unknown as ClientRequest;
    });
    return mock;
  }

  it.each([
    [
      Object.assign(new Error("self-signed certificate secret=abc"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    ],
    [
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
      "ECONNREFUSED",
    ],
    [new Error("Bearer challenge leaked in message"), "transport_failed"],
    [
      Object.assign(new Error("odd"), { code: "has spaces / Bearer x" }),
      "transport_failed",
    ],
  ])("the default verified-https transport reports a normalized code, never the message (%#)", async (error, code) => {
    const mock = mockHttps(error);
    const result = await new HttpProbe().qualification(QUALIFY);
    expect(result).toMatchObject({ status: 0, body: "", error: code });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "bad host/",
    "127.0.0.1",
    "localhost",
    "[::1]",
  ])("refuses destination %s before any request", async (ingressHost) => {
    const mock = vi.mocked(httpsRequest);
    mock.mockReset();
    const result = await new HttpProbe().qualification({
      ...QUALIFY,
      ingressHost,
    });
    expect(result).toMatchObject({ status: 0, error: "invalid_destination" });
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("qualification over a real local socket", () => {
  type Handler = (req: ServerIncomingMessage, res: ServerResponse) => void;
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    s?.closeAllConnections();
    await new Promise<void>((done) => (s ? s.close(() => done()) : done()));
  });
  /** A real node:http server; the seam keeps every option and only redirects the socket to it. */
  async function serve(handler: Handler) {
    const seen: RequestOptions[] = [];
    const hosts: (string | undefined)[] = [];
    server = createServer((req, res) => {
      hosts.push(req.headers.host);
      handler(req, res);
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const probe = new HttpProbe({
      qualificationRequest: (options, onResponse) => {
        seen.push(options);
        return httpRequest(
          { ...options, hostname: "127.0.0.1", port, agent: false },
          onResponse
        );
      },
    });
    return { probe, seen, hosts };
  }

  it.each([
    200, 302, 421,
  ])("returns status %s once, sends the ingress as Host and never follows a redirect", async (status) => {
    let requests = 0;
    const { probe, seen, hosts } = await serve((_req, res) => {
      requests++;
      res.writeHead(status, { location: "https://attacker.invalid/steal" });
      res.end("evidence");
    });
    const result = await probe.qualification(QUALIFY);
    expect(result).toMatchObject({ status, body: "evidence" });
    expect(requests).toBe(1);
    expect(hosts).toEqual(["green.provider.example"]);
    expect(seen[0]).toMatchObject({
      servername: "green.provider.example",
      headers: { host: "green.provider.example" },
    });
  });

  it("settles response_unavailable when the peer resets after headers, mid-body", async () => {
    const { probe } = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial-evidence");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const t0 = Date.now();
    const result = await probe.qualification(QUALIFY);
    expect(result).toMatchObject({
      status: 0,
      body: "",
      error: "response_unavailable",
    });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("settles response_too_large and drops the body for an oversize response", async () => {
    const { probe } = await serve((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(40_000));
    });
    const result = await probe.qualification(QUALIFY);
    expect(result).toMatchObject({
      status: 0,
      body: "",
      error: "response_too_large",
    });
  });

  it("settles timeout for a slow body within the caller's deadline", async () => {
    const { probe } = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("slow");
    });
    const t0 = Date.now();
    const result = await probe.qualification({ ...QUALIFY, timeoutMs: 200 });
    expect(result).toMatchObject({ status: 0, body: "", error: "timeout" });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("reports a real refused connection by its code", async () => {
    const probe = new HttpProbe({
      qualificationRequest: (options, onResponse) =>
        httpRequest(
          { ...options, hostname: "127.0.0.1", port: 1, agent: false },
          onResponse
        ),
    });
    const result = await probe.qualification(QUALIFY);
    expect(result).toMatchObject({ status: 0, error: "ECONNREFUSED" });
  });
});
