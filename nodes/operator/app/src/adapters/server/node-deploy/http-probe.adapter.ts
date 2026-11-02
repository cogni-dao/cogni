// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/http-probe.adapter`
 * Purpose: The sequencer's probes (task.5400): a Host-routed request to a provider ingress (proves
 *   which lease the provider routes a public name to), a public HTTPS read resolved through
 *   Cloudflare DoH (proves what real clients see, immune to a poisoned local resolver), and a
 *   Postgres SSLRequest handshake (proves a state lease serves TLS).
 * Scope: Bounded IO only; the verdict (exact sha, streaks, deadlines) lives in the sequencer.
 * Invariants:
 *   - BOUNDED: every call has a timeout and never throws; failure is a `status: 0` result.
 * Side-effects: IO (HTTP/HTTPS/TCP)
 * @internal
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";

import type { HttpResult, ProbePort } from "@/ports";

export class HttpProbe implements ProbePort {
  constructor(private readonly timeoutMs = 8_000) {}

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
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) =>
        resolve({ status: 0, body: "", ms: Date.now() - t0, error: e.message })
      );
      req.end();
    });
  }

  async publicDoh(host: string, path: string): Promise<HttpResult> {
    const t0 = Date.now();
    try {
      const doh = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
        {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        }
      );
      const answers =
        ((await doh.json()) as { Answer?: { type: number; data: string }[] })
          .Answer ?? [];
      const ip = answers.find((a) => a.type === 1)?.data;
      if (!ip)
        return {
          status: 0,
          body: "",
          ms: Date.now() - t0,
          error: "doh: no A record yet",
        };
      return await new Promise<HttpResult>((resolve) => {
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
              resolve({
                status: res.statusCode ?? 0,
                body,
                ms: Date.now() - t0,
              })
            );
          }
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", (e) =>
          resolve({
            status: 0,
            body: "",
            ms: Date.now() - t0,
            error: `doh-path ${e.message}`,
          })
        );
        req.end();
      });
    } catch (e) {
      return {
        status: 0,
        body: "",
        ms: Date.now() - t0,
        error: `doh ${(e as Error).message}`,
      };
    }
  }

  /** Postgres SSLRequest: the server answers 'S' when TLS is available. */
  tcpTls(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host, port });
      const done = (v: boolean) => {
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
