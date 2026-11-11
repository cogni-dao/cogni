// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/node-service-links/node-host-transport`
 * Purpose: The host-bound transport to a linked node: default-deny paths, stored origin only, header
 *   added last, no response headers, key patterns scrubbed (story.0038).
 * Scope: Fake `fetch`; no network.
 * Side-effects: none
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNodeHostTransport,
  scrubAgentKeys,
} from "@/adapters/server/node-service-links/node-host-transport";

const AUDIENCE = "https://x-test.example.org";
const connection = {
  connectionId: "conn-1",
  credentials: { accessToken: "cogni_ag_sk_v2_TESTKEYVALUE" },
} as const;
const log = { info: vi.fn(), warn: vi.fn() };
const transport = createNodeHostTransport({ log });
const call = (path: string, audience = AUDIENCE) =>
  transport.get({ connection, audience, targetNodeId: "node-x", path });

describe("node host transport", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("allows only the two knowledge GET paths and blocks credential routes with an event", async () => {
    for (const path of [
      "/api/v1/agent/credentials/rotate",
      "/api/v1/agent/credentials/confirm",
      "/api/v1/knowledge/index?x=1",
      "/api/v1/knowledge/a/b",
      "/api/v1/work/items",
    ]) {
      await expect(call(path)).resolves.toEqual({
        ok: false,
        reason: "path_not_allowed",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent.node_call.blocked" }),
      "agent.node_call.blocked"
    );
  });

  it("refuses a non-https or non-origin audience", async () => {
    await expect(
      call("/api/v1/knowledge/index", "http://x.example.org")
    ).resolves.toEqual({ ok: false, reason: "origin_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends GET with redirect manual, adds the bearer header, returns status and scrubbed body only", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        '{"echo":"cogni_ag_sk_v1_abc-DEF_9 and cogni_ag_sk_v2_xyz"}',
        {
          status: 200,
          headers: { "set-cookie": "a=b" },
        }
      )
    );
    const result = await call("/api/v1/knowledge/node-template-architect");
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: '{"echo":"[REDACTED] and [REDACTED]"}',
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(
      `${AUDIENCE}/api/v1/knowledge/node-template-architect`
    );
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer cogni_ag_sk_v2_TESTKEYVALUE"
    );
    // The call event carries the template, never a key, header or body.
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).toContain("/api/v1/knowledge/{id}");
    expect(logged).not.toContain("cogni_ag_sk_");
  });

  it("a network failure is `unreachable`, not a throw", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(call("/api/v1/knowledge/index")).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("scrubAgentKeys leaves ordinary text alone", () => {
    expect(scrubAgentKeys("no key here")).toBe("no key here");
  });

  it("refuses a declared content-length above 1 MiB and stops a streamed body at the cap, with a warn event", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { headers: { "content-length": "2000000" } })
    );
    await expect(call("/api/v1/knowledge/index")).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
    const big = new Uint8Array(512 * 1024);
    let pulled = 0;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            controller.enqueue(big);
            if (pulled > 100) controller.close();
          },
        })
      )
    );
    await expect(call("/api/v1/knowledge/index")).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
    // The counter stops the read near the cap, far before the stream's end.
    expect(pulled).toBeLessThan(10);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "node_response_too_large" }),
      "agent.node_call"
    );
  });

  it("an unreachable node logs a warn with a stable errorCode", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    await call("/api/v1/knowledge/index");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "node_unreachable" }),
      "agent.node_call"
    );
  });

  it("perCallEvents:false emits no per-call event (the caller logs one summary), even on failure", async () => {
    const quiet = createNodeHostTransport({ log, perCallEvents: false });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    for (let i = 0; i < 2; i++) {
      await quiet.get({
        connection,
        audience: AUDIENCE,
        targetNodeId: "node-x",
        path: "/api/v1/knowledge/index",
      });
    }
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
