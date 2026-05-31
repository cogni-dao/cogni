// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/sandbox/openclaw-gateway-client`
 * Purpose: Minimal WebSocket client for OpenClaw gateway protocol (connect handshake + agent/sessions methods).
 * Scope: Test fixture only — NOT for production use. Implements just enough of the protocol for outboundHeaders testing.
 * Invariants: One client = one WS connection = one authenticated session.
 * Side-effects: IO (WebSocket connections)
 * Links: docs/research/openclaw-gateway-header-injection.md
 * @internal
 */

import WebSocket from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Types (subset of OpenClaw gateway protocol)
// ─────────────────────────────────────────────────────────────────────────────

interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: number; message: string };
}

interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
}

type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

export interface ConnectOptions {
  url: string;
  token: string;
  /** Timeout for the full connect handshake (ms). Default: 5000 */
  connectTimeoutMs?: number;
}

export interface AgentCallOptions {
  message: string;
  agentId?: string;
  /** Session correlation key — REQUIRED per WS_EVENT_CAUSALITY. */
  sessionKey: string;
  outboundHeaders?: Record<string, string>;
  /** Timeout waiting for the agent response (ms). Default: 15000 */
  timeoutMs?: number;
}

export interface SessionsPatchOptions {
  sessionKey: string;
  outboundHeaders?: Record<string, string> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export class OpenClawGatewayClient {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pendingResponses = new Map<
    string,
    {
      resolve: (frame: ResponseFrame) => void;
      reject: (err: Error) => void;
    }
  >();
  private eventHandlers: Array<(event: EventFrame) => void> = [];
  private _closed = false;

  get closed(): boolean {
    return this._closed;
  }

  /**
   * Connect to gateway, perform handshake, authenticate.
   * Resolves when hello-ok received, rejects on auth failure or timeout.
   */
  async connect(options: ConnectOptions): Promise<void> {
    const { url, token, connectTimeoutMs = 5000 } = options;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(`Gateway connect timeout after ${connectTimeoutMs}ms`)
        );
        this.close();
      }, connectTimeoutMs);

      this.ws = new WebSocket(url);

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message}`));
      });

      this.ws.on("close", (code, reason) => {
        this._closed = true;
        clearTimeout(timeout);
        // Reject all pending responses
        for (const [, pending] of this.pendingResponses) {
          pending.reject(
            new Error(`Connection closed: ${code} ${reason.toString()}`)
          );
        }
        this.pendingResponses.clear();
      });

      let handshakeComplete = false;

      this.ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as GatewayFrame;

        // During handshake: wait for challenge, send connect, wait for hello-ok
        if (!handshakeComplete) {
          if (frame.type === "event" && frame.event === "connect.challenge") {
            // Send connect request with auth
            this.sendFrame({
              type: "req",
              id: this.allocId(),
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "test",
                  version: "1.0.0",
                  platform: "node-test",
                  mode: "test",
                },
                auth: { token },
              },
            });
            return;
          }

          if (frame.type === "res") {
            if (frame.ok) {
              // hello-ok — handshake complete
              handshakeComplete = true;
              clearTimeout(timeout);
              // Switch to normal message handling
              this.ws?.removeAllListeners("message");
              this.ws?.on("message", (d) => this.handleMessage(d));
              resolve();
            } else {
              clearTimeout(timeout);
              reject(
                new Error(
                  `Gateway auth failed: ${frame.error?.message ?? "unknown"}`
                )
              );
            }
            return;
          }

          // Ignore other events during handshake (tick, etc.)
          return;
        }
      });
    });
  }

  /**
   * Send an agent call, optionally with outboundHeaders.
   * Resolves with the response frame when the agent completes.
   */
  async agent(options: AgentCallOptions): Promise<ResponseFrame> {
    const {
      message,
      agentId = "main",
      sessionKey,
      outboundHeaders,
      timeoutMs = 15000,
    } = options;

    const params: Record<string, unknown> = {
      message,
      agentId,
      sessionKey,
      idempotencyKey: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (outboundHeaders) params.outboundHeaders = outboundHeaders;

    return this.request("agent", params, timeoutMs);
  }

  /**
   * Patch session state (e.g., set/clear outboundHeaders).
   * Fields go at the top level alongside `key` (NOT nested under a `patch` object).
   */
  async sessionsPatch(options: SessionsPatchOptions): Promise<ResponseFrame> {
    const { sessionKey, outboundHeaders } = options;

    const params: Record<string, unknown> = { key: sessionKey };
    if (outboundHeaders !== undefined) {
      params.outboundHeaders = outboundHeaders;
    }

    return this.request("sessions.patch", params, 5000);
  }

  /** Register a handler for server-push events */
  onEvent(handler: (event: EventFrame) => void): void {
    this.eventHandlers.push(handler);
  }

  /** Close the WebSocket connection */
  close(): void {
    if (this.ws && !this._closed) {
      this._closed = true;
      this.ws.close();
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private allocId(): string {
    return String(++this.nextId);
  }

  private sendFrame(frame: RequestFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    this.ws.send(JSON.stringify(frame));
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<ResponseFrame> {
    return new Promise((resolve, reject) => {
      const id = this.allocId();
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(
          new Error(
            `Request ${method} (id=${id}) timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      this.pendingResponses.set(id, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.sendFrame({ type: "req", id, method, params });
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    const frame = JSON.parse(data.toString()) as GatewayFrame;

    if (frame.type === "res") {
      const pending = this.pendingResponses.get(frame.id);
      if (pending) {
        this.pendingResponses.delete(frame.id);
        pending.resolve(frame);
      }
      return;
    }

    if (frame.type === "event") {
      for (const handler of this.eventHandlers) {
        handler(frame);
      }
    }
  }
}
