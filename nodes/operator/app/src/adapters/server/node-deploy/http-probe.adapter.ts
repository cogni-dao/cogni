// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/http-probe.adapter`
 * Purpose: The sequencer's probes (task.5400): a Host-routed request to a provider ingress (proves
 *   which lease the provider routes a public name to), a public HTTPS read at an IP the zone's
 *   authoritative nameservers give (proves what real clients see, immune to a poisoned local resolver
 *   and to a public resolver's cached NXDOMAIN for a new host), and a Postgres SSLRequest handshake
 *   (proves a state lease serves TLS).
 * Scope: Bounded IO only; the verdict (exact sha, streaks, deadlines) lives in the sequencer.
 * Invariants:
 *   - BOUNDED: every call has a timeout and never throws; failure is a `status: 0` result.
 *   - NO_NEGATIVE_CACHE (story.5137): the public read never asks a recursive resolver for the new host;
 *     it asks the zone's authoritative nameservers. Cloudflare DoH is only the fallback when that path is
 *     unreachable, never when the authoritative answer is "no record".
 * Side-effects: IO (HTTP/HTTPS/TCP)
 * @internal
 */

import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";

import type { HttpResult, ProbePort } from "@/ports";

/** The DNS primitives the public read needs. `servers` set = ask those servers directly (no recursion cache). */
export interface ProbeDns {
  ns(name: string): Promise<string[]>;
  a(name: string, servers?: string[]): Promise<string[]>;
}

/** An HTTPS GET to `ip` presenting `host` as Host and SNI. */
export type PinnedGet = (
  ip: string,
  host: string,
  path: string
) => Promise<HttpResult>;

export interface HttpProbeOptions {
  readonly timeoutMs?: number;
  readonly dns?: ProbeDns;
  readonly fetchImpl?: typeof fetch;
  readonly pinnedGet?: PinnedGet;
}

const ZONE_TTL_MS = 10 * 60_000;

/** NXDOMAIN or no A data: the name has no record (yet). Not a transport failure. */
function isNoRecord(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

function nodeDns(timeoutMs: number): ProbeDns {
  return {
    ns: (name) => dns.resolveNs(name),
    a: (name, servers) => {
      if (!servers) return dns.resolve4(name);
      const r = new dns.Resolver({
        timeout: Math.min(timeoutMs, 3_000),
        tries: 2,
      });
      r.setServers(servers);
      return r.resolve4(name);
    },
  };
}

export class HttpProbe implements ProbePort {
  private readonly timeoutMs: number;
  private readonly dns: ProbeDns;
  private readonly fetchImpl: typeof fetch;
  private readonly get: PinnedGet;
  private readonly zoneCache = new Map<
    string,
    { servers: string[]; until: number }
  >();

  constructor(opts: HttpProbeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.dns = opts.dns ?? nodeDns(this.timeoutMs);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.get =
      opts.pinnedGet ?? ((ip, host, path) => this.pinnedGet(ip, host, path));
  }

  hostRouted(
    ingressHost: string,
    hostHeader: string,
    path: string
  ): Promise<HttpResult> {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const req = httpRequest(
        {
          host: ingressHost,
          path,
          method: "GET",
          headers: { host: hostHeader, "cache-control": "no-cache" },
          timeout: this.timeoutMs,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            if (body.length < 16_384) body += c;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body, ms: Date.now() - t0 })
          );
        }
      );
      // HARD deadline (idle `timeout` does not bound a stalled DNS lookup).
      const hard = setTimeout(
        () => req.destroy(new Error("hard timeout")),
        this.timeoutMs + 2_000
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => {
        clearTimeout(hard);
        resolve({ status: 0, body: "", ms: Date.now() - t0, error: e.message });
      });
      req.on("close", () => clearTimeout(hard));
      req.end();
    });
  }

  /**
   * GET `https://<host><path>` at an IP the zone's AUTHORITATIVE nameservers give for `host`, with the
   * real Host header and SNI. The read itself goes through the public Cloudflare edge, as a client's does.
   */
  async publicRead(host: string, path: string): Promise<HttpResult> {
    const t0 = Date.now();
    const fail = (error: string): HttpResult => ({
      status: 0,
      body: "",
      ms: Date.now() - t0,
      error,
    });
    let ip: string | undefined;
    try {
      ip = await this.authoritativeA(host);
    } catch (e) {
      if (isNoRecord(e)) return fail("authoritative: no A record yet");
      // The authoritative path is unavailable (no zone NS, port 53 blocked, timeout): fall back to DoH.
      try {
        ip = await this.dohA(host);
      } catch (e2) {
        return fail(
          `dns ${(e as Error).message}; doh ${(e2 as Error).message}`
        );
      }
      if (!ip) return fail("doh: no A record yet");
    }
    if (!ip) return fail("authoritative: no A record yet");
    const r = await this.get(ip, host, path);
    return { ...r, ms: Date.now() - t0 };
  }

  /**
   * NO_NEGATIVE_CACHE (story.5137): ask the zone's own nameservers, never a caching resolver. A public
   * resolver that saw NXDOMAIN for a brand-new host keeps it for the zone SOA minimum (30 min), so the
   * readback of a new node's first release would fail although the record exists. The walk to the zone
   * starts at the PARENT of `host` (a 2-label host is its own zone apex), so `host` itself is never sent
   * to a recursive resolver and no negative cache entry is created for it.
   */
  private async authoritativeA(host: string): Promise<string | undefined> {
    const servers = await this.zoneServers(host);
    const ips = await this.dns.a(host, servers);
    return ips[0];
  }

  private async zoneServers(host: string): Promise<string[]> {
    const labels = host.replace(/\.$/, "").split(".");
    const from = labels.length > 2 ? 1 : 0;
    const key = labels.slice(from).join(".");
    const hit = this.zoneCache.get(key);
    if (hit && hit.until > Date.now()) return hit.servers;
    for (let i = from; i <= labels.length - 2; i++) {
      const name = labels.slice(i).join(".");
      let ns: string[];
      try {
        ns = await this.dns.ns(name);
      } catch (e) {
        if (isNoRecord(e)) continue;
        throw e;
      }
      if (ns.length === 0) continue;
      const servers = (
        await Promise.all(ns.map((n) => this.dns.a(n).catch(() => [])))
      ).flat();
      if (servers.length === 0) break;
      this.zoneCache.set(key, { servers, until: Date.now() + ZONE_TTL_MS });
      return servers;
    }
    throw new Error(`no zone nameservers found for ${host}`);
  }

  private async dohA(host: string): Promise<string | undefined> {
    const doh = await this.fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );
    const answers =
      ((await doh.json()) as { Answer?: { type: number; data: string }[] })
        .Answer ?? [];
    return answers.find((a) => a.type === 1)?.data;
  }

  private pinnedGet(
    ip: string,
    host: string,
    path: string
  ): Promise<HttpResult> {
    const t0 = Date.now();
    return new Promise<HttpResult>((resolve) => {
      const req = httpsRequest(
        {
          host: ip,
          servername: host,
          path,
          method: "GET",
          headers: { host, "cache-control": "no-cache" },
          timeout: this.timeoutMs,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            if (body.length < 16_384) body += c;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body, ms: Date.now() - t0 })
          );
        }
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) =>
        resolve({
          status: 0,
          body: "",
          ms: Date.now() - t0,
          error: `public-path ${e.message}`,
        })
      );
      req.end();
    });
  }

  /** Postgres SSLRequest: the server answers 'S' when TLS is available. */
  tcpTls(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host, port });
      // HARD deadline: `socket.setTimeout` is an IDLE timer and does not bound a stalled DNS lookup.
      const hard = setTimeout(() => done(false), this.timeoutMs);
      const done = (v: boolean) => {
        clearTimeout(hard);
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(this.timeoutMs, () => done(false));
      sock.on("error", () => done(false));
      sock.on("connect", () =>
        sock.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]))
      );
      sock.on("data", (d) => done(d[0] === 0x53));
    });
  }
}
