// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/http-probe.adapter.test`
 * Purpose: Prove qualification transport verifies observed ingress TLS and selects the declared HTTP Host.
 * Scope: Native HTTPS transport fake; does not contact providers or sequence releases.
 * Invariants: Certificate failures and redirects refuse proof; no retry or disabled TLS verification.
 * Side-effects: none
 * Links: http-probe.adapter.ts, bug.5568
 * @internal
 */

import { EventEmitter } from "node:events";
import { type ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { HttpProbe } from "./http-probe.adapter";

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
