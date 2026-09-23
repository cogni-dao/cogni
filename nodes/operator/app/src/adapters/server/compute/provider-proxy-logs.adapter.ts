// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/provider-proxy-logs.adapter`
 * Purpose: Read one Akash lease's current log window through the Console provider-proxy
 *   (bug.5240). The provider gateway serves lease logs over WEBSOCKET ONLY — a plain GET
 *   passes auth and then dies on gorilla's upgrader with `400 Bad Request` (proven live on
 *   prod, 2026-09-23) — so this client speaks the proxy's relay protocol
 *   (console apps/provider-proxy WebsocketServer.ts): one client frame
 *   `{type:"websocket", url, providerAddress, auth:{type:"jwt",token}}` opens the
 *   cert-validated provider socket; the proxy relays each provider frame back as
 *   `{type:"websocket", message}` and signals provider close with `{closed:true}`.
 * Scope: WS IO + frame decoding + line parsing only. Which leases to read, how often, and
 *   what the lines mean is the pump's business. Uses Node's NATIVE WebSocket (v22+) — no
 *   new dependency.
 * Invariants:
 *   - EPHEMERAL_TOKEN_PER_CALL: the logs-scoped JWT arrives per call and is never stored.
 *   - BOUNDED_SNAPSHOT: always `follow=false` — the provider replays the tail and closes
 *     (`closed:true` relayed). Idle and hard-cap timers backstop a proxy that never says
 *     close; one read can never hold a stream open past `hardCapMs`.
 *   - MALFORMED_LINES_SURVIVE: an unparseable NDJSON row ships as a raw message on the
 *     lease's own name rather than being dropped — diagnosis data is never discarded.
 * Side-effects: IO (WSS to the Console provider-proxy)
 * Links: @ports/lease-log.port, features/compute/lease-log-pump/lease-log-pump.ts,
 *   github.com/akash-network/console apps/provider-proxy/src/services/WebsocketServer.ts,
 *   bug.5240, task.5144
 * @internal
 */

import type { ProviderLeaseLogLine, ProviderLeaseLogReaderPort } from "@/ports";

export interface ProviderProxyLogsConfig {
  /** Provider-proxy base, e.g. `https://console.akash.network/provider-proxy-mainnet`. */
  readonly proxyUrl: string;
  /** Injectable WebSocket constructor for tests; defaults to the Node 22 global. */
  readonly webSocketImpl?: typeof WebSocket;
  /** Frames-quiet window that ends a read early. Default 1500ms. */
  readonly idleMs?: number;
  /** Absolute per-read budget. Default 12s. */
  readonly hardCapMs?: number;
}

/** One relayed proxy frame (WebsocketServer.ts `linkSockets` / provider-close shapes). */
interface ProxyFrame {
  readonly type?: string;
  readonly message?: unknown;
  readonly error?: unknown;
  readonly closed?: boolean;
}

export class ProviderProxyLogsClient implements ProviderLeaseLogReaderPort {
  private readonly webSocketImpl: typeof WebSocket;
  private readonly idleMs: number;
  private readonly hardCapMs: number;

  constructor(private readonly config: ProviderProxyLogsConfig) {
    this.webSocketImpl = config.webSocketImpl ?? WebSocket;
    this.idleMs = config.idleMs ?? 1_500;
    this.hardCapMs = config.hardCapMs ?? 12_000;
  }

  read(input: {
    readonly providerHostUri: string;
    readonly providerAccount: string;
    readonly dseq: string;
    readonly gseq: number;
    readonly oseq: number;
    readonly token: string;
    readonly tail: number;
  }): Promise<readonly ProviderLeaseLogLine[]> {
    const base = input.providerHostUri.replace(/\/+$/, "");
    // Keep https:// — the proxy itself rewrites to wss:// for the provider hop.
    const leaseLogsUrl =
      `${base}/lease/${encodeURIComponent(input.dseq)}/${input.gseq}/` +
      `${input.oseq}/logs?follow=false&tail=${input.tail}`;
    const proxyWsUrl = this.config.proxyUrl
      .replace(/\/+$/, "")
      .replace(/^http/, "ws");
    const fallbackName = `dseq-${input.dseq}`;

    return new Promise((resolve, reject) => {
      const socket = new this.webSocketImpl(proxyWsUrl);
      const chunks: string[] = [];
      let settled = false;
      let sawError: string | undefined;
      let idleTimer: NodeJS.Timeout | undefined;

      const finish = (failure?: Error): void => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        try {
          socket.close();
        } catch {
          // already closed
        }
        if (failure) reject(failure);
        else resolve(parseLeaseLogWindow(chunks.join("\n"), fallbackName));
      };

      const hardTimer = setTimeout(
        () => finish(),
        this.hardCapMs
      ) as NodeJS.Timeout;
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(), this.idleMs) as NodeJS.Timeout;
      };

      socket.addEventListener("open", () => {
        armIdle();
        socket.send(
          JSON.stringify({
            type: "websocket",
            url: leaseLogsUrl,
            providerAddress: input.providerAccount,
            auth: { type: "jwt", token: input.token },
          })
        );
      });

      socket.addEventListener("message", (event) => {
        armIdle();
        const frame = decodeProxyFrame(event.data);
        if (!frame) return;
        if (frame.closed) {
          // Provider replayed the window and closed (follow=false) — done. Zero data
          // plus a recorded relay error means the upstream refused; surface it.
          if (chunks.length === 0 && sawError) {
            finish(new Error(sawError));
            return;
          }
          finish();
          return;
        }
        if (frame.error !== undefined && frame.error !== null) {
          sawError = `provider-proxy relay error: ${String(frame.error).slice(0, 200)}`;
          return;
        }
        const text = decodeFrameMessage(frame.message);
        if (text) chunks.push(text);
      });

      socket.addEventListener("error", () => {
        finish(new Error(`provider-proxy websocket error (${proxyWsUrl})`));
      });
      socket.addEventListener("close", () => finish());
    });
  }
}

/**
 * Decode one relayed frame. The proxy JSON-stringifies whatever `ws` delivered from the
 * provider, so `message` may be a string OR a serialized Buffer (`{type:"Buffer",data:[…]}`).
 */
export function decodeProxyFrame(raw: unknown): ProxyFrame | undefined {
  if (typeof raw !== "string") {
    // Binary frame — not part of the relay contract; ignore.
    return undefined;
  }
  try {
    return JSON.parse(raw) as ProxyFrame;
  } catch {
    return { type: "websocket", message: raw };
  }
}

/** Extract the provider bytes from a relayed `message` field as utf8 text. */
export function decodeFrameMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const buf = message as { type?: unknown; data?: unknown };
    if (buf.type === "Buffer" && Array.isArray(buf.data)) {
      return Buffer.from(buf.data as number[]).toString("utf8");
    }
  }
  return "";
}

/** Parse an NDJSON lease-log window. Exported for tests. */
export function parseLeaseLogWindow(
  text: string,
  fallbackName: string
): readonly ProviderLeaseLogLine[] {
  const lines: ProviderLeaseLogLine[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        name?: unknown;
        message?: unknown;
      };
      if (typeof parsed.message === "string") {
        lines.push({
          name: typeof parsed.name === "string" ? parsed.name : fallbackName,
          message: parsed.message,
        });
        continue;
      }
    } catch {
      // fall through: ship the raw row under the lease's own name
    }
    lines.push({ name: fallbackName, message: trimmed });
  }
  return lines;
}
