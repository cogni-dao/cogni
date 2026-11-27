// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { HttpLokiReader } from "@/adapters/server/observability/loki-reader.adapter";

const scoped = () => '{service="scheduler-worker"}';

describe("real bounded Loki HTTP transport", () => {
  it("caps streamed bytes before parsing and refuses oversized lines without echoing bodies", async () => {
    let mode = "bytes";
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (mode === "bytes") {
        response.write(" ".repeat(131073));
        response.end();
      } else {
        response.end(
          JSON.stringify({
            data: {
              result: [
                { values: [["123", "PRIVATE_BODY_SENTINEL".repeat(200)]] },
              ],
            },
          })
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const reader = new HttpLokiReader({
      grafanaUrl: `http://127.0.0.1:${address.port}`,
      token: "PRIVATE_TOKEN_SENTINEL",
    });
    try {
      for (mode of ["bytes", "line"])
        await expect(
          reader.queryRange({
            query: scoped(),
            startNs: "1",
            endNs: "2",
            limit: 100,
            bounds: { timeoutMs: 1000, maxBytes: 131072, maxLineBytes: 2048 },
          })
        ).rejects.toThrow("loki_response_bounds");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("actual HTTP abort stops a stalled response body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    try {
      const reader = new HttpLokiReader({
        grafanaUrl: `http://127.0.0.1:${address.port}`,
        token: "secret",
      });
      const start = Date.now();
      await expect(
        reader.queryRange({
          query: scoped(),
          startNs: "1",
          endNs: "2",
          limit: 100,
          bounds: { timeoutMs: 100, maxBytes: 131072, maxLineBytes: 2048 },
        })
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(900);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
