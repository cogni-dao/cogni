// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox/openclaw-gateway-client`
 * Purpose: WebSocket client for OpenClaw gateway protocol (custom frame format, not JSON-RPC).
 * Scope: Connects to gateway, sends agent calls with outboundHeaders for billing, consumes agent events (lifecycle, tool, compaction) as StatusEvent. Does not manage containers.
 * Invariants:
 *   - Per BILLING_INDEPENDENT_OF_CLIENT: billing headers passed as outboundHeaders per agent call
 *   - Per SECRETS_HOST_ONLY: no LiteLLM keys ever sent to gateway
 *   - Per WS_EVENT_CAUSALITY: chat events are filtered by sessionKey — only frames matching the current request's sessionKey are processed; all others are dropped (prevents cross-run contamination from broadcasts)
 *   - Frame format: { type: "req"|"res"|"event", id, method, params } (NOT JSON-RPC 2.0)
 *   - Handshake: challenge → connect(auth) → hello-ok (3-step)
 *   - Agent protocol: ACK res (accepted) → optional chat deltas → chat final signal → final "ok" res with result.payloads (authoritative)
 * Side-effects: IO (WebSocket connections to gateway)
 * Links: docs/research/openclaw-gateway-integration-handoff.md, docs/spec/openclaw-sandbox-spec.md
 * @internal
 */

import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import WebSocket from "ws";

import { EVENT_NAMES, makeLogger } from "@/shared/observability";

// ─────────────────────────────────────────────────────────────────────────────
// Protocol types (subset of OpenClaw gateway protocol)
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

// ─────────────────────────────────────────────────────────────────────────────
// Typed agent events (maps 1:1 to AiEvent in provider)
// ─────────────────────────────────────────────────────────────────────────────

/** Typed events yielded during a gateway agent run. */
export type GatewayAgentEvent =
  | { type: "accepted"; runId: string }
  | { type: "text_delta"; text: string }
  | { type: "chat_final"; text: string }
  | { type: "chat_error"; message: string }
  | {
      type: "status";
      phase: "thinking" | "tool_use" | "compacting";
      label?: string;
    };

/** Options for {@link OpenClawGatewayClient.runAgent}. */
export interface RunAgentOptions {
  message: string;
  /**
   * Session correlation key — REQUIRED for event isolation.
   * Only chat events whose payload.sessionKey matches this value are processed;
   * all others are dropped. Without this, cross-run contamination is possible
   * because the gateway broadcasts chat events to all connected WS clients.
   */
  sessionKey: string;
  outboundHeaders?: Record<string, string>;
  /** Total timeout for the operation (default: 120s). */
  timeoutMs?: number;
  /** Caller-provided logger with pre-bound context (runId, etc.). */
  log?: Logger;
}

/**
 * WebSocket client for the OpenClaw gateway.
 *
 * Uses the OpenClaw custom frame protocol (NOT JSON-RPC 2.0):
 * - Request: { type: "req", id, method, params }
 * - Response: { type: "res", id, ok, payload/error }
 * - Event: { type: "event", event, payload }
 *
 * Each call opens a new WS connection, performs the 3-step handshake,
 * sends the request, and closes on completion.
 * This is safe for concurrent use (one connection per call).
 */
export class OpenClawGatewayClient {
  private readonly log: Logger;

  constructor(
    private readonly gatewayUrl: string,
    private readonly token: string
  ) {
    this.log = makeLogger({ component: "OpenClawGatewayClient" });
  }

  /**
   * Run an agent call via the gateway WS protocol.
   *
   * State machine (single WS connection):
   *   init → accepted ACK (metadata) → optional chat deltas (streaming) →
   *   chat_final signal (ignored) → final "ok" res with result.payloads (authoritative, terminal)
   *
   * Terminal conditions:
   *   - Success: second res frame with payload.status === "ok" and payload.result
   *   - Failure: any res with ok===false, chat event state==="error"/"aborted", or timeout
   *
   * Yields typed {@link GatewayAgentEvent}:
   *   1. accepted — ACK (agent queued, carries runId)
   *   2. text_delta — incremental streaming text (0–N, from chat deltas)
   *   3. chat_final — complete response text from result.payloads (terminal)
   *   4. chat_error — error or abort (terminal)
   */
  async *runAgent(opts: RunAgentOptions): AsyncGenerator<GatewayAgentEvent> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const wsUrl = this.gatewayUrl.replace(/^http/, "ws");
    const log = opts.log ?? this.log;
    const startTime = Date.now();

    log.info(
      {
        sessionKey: opts.sessionKey,
        hasHeaders: !!opts.outboundHeaders,
        timeoutMs,
      },
      "Starting gateway agent call"
    );

    // Push→pull bridge: WS events push items, generator loop pulls them.
    type QueueItem =
      | { kind: "event"; value: GatewayAgentEvent }
      | { kind: "done" }
      | { kind: "error"; error: Error }
      | { kind: "ws_closed" }
      | { kind: "heartbeat" };

    const queue: QueueItem[] = [];
    let notify: (() => void) | null = null;
    let terminalSeen = false;

    const push = (item: QueueItem) => {
      queue.push(item);
      if (notify) {
        notify();
        notify = null;
      }
    };

    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      push({
        kind: "error",
        error: new Error(`Gateway call timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
    const heartbeatInterval = setInterval(() => {
      push({ kind: "heartbeat" });
    }, 30_000);

    try {
      // Phase 1: Handshake (blocking)
      const allocId = await this.performHandshake(ws, timer, push);

      // Phase 2: Send agent request
      const agentRequestId = allocId();
      const params: Record<string, unknown> = {
        message: opts.message,
        agentId: "main",
        sessionKey: opts.sessionKey,
        idempotencyKey: `cogni-${randomUUID()}`,
      };
      if (opts.outboundHeaders) params.outboundHeaders = opts.outboundHeaders;

      ws.send(
        JSON.stringify({
          type: "req",
          id: agentRequestId,
          method: "agent",
          params,
        })
      );

      // Phase 3: State machine frame dispatch
      // Accumulated text from chat deltas (for diff-based streaming)
      let prevText = "";

      ws.removeAllListeners("message");
      ws.on("message", (data: WebSocket.RawData) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as GatewayFrame;
        } catch {
          push({
            kind: "error",
            error: new Error("Failed to parse gateway frame"),
          });
          return;
        }

        // ── res frames for our agent request ──────────────────────────
        if (frame.type === "res" && frame.id === agentRequestId) {
          // Terminal failure: server rejected the frame
          if (!frame.ok) {
            terminalSeen = true;
            push({
              kind: "event",
              value: {
                type: "chat_error",
                message: frame.error?.message ?? "Agent call rejected",
              },
            });
            push({ kind: "done" });
            return;
          }

          const payload = frame.payload as Record<string, unknown> | undefined;
          const status = payload?.status as string | undefined;

          // ACK: { status: "accepted", runId } — metadata only, not terminal
          if (status === "accepted") {
            push({
              kind: "event",
              value: {
                type: "accepted",
                runId: (payload?.runId as string) ?? "",
              },
            });
            return;
          }

          // Final res: { status: "ok", result: { payloads, meta } } — authoritative terminal
          if (status === "ok") {
            terminalSeen = true;
            const text = extractTextFromResult(payload);
            if (text) {
              push({ kind: "event", value: { type: "chat_final", text } });
            } else {
              // Empty payloads is a real error — surface structured info for debugging
              const meta = (payload?.result as Record<string, unknown>)?.meta as
                | Record<string, unknown>
                | undefined;
              const model = (meta?.agentMeta as Record<string, unknown>)
                ?.model as string | undefined;
              push({
                kind: "event",
                value: {
                  type: "chat_error",
                  message:
                    `Gateway returned ok but result.payloads is empty — ` +
                    `likely provider parse/wiring bug ` +
                    `(model=${model ?? "unknown"}, runId=${(payload?.runId as string) ?? "?"})`,
                },
              });
            }
            push({ kind: "done" });
            return;
          }

          // Error res: { status: "error", summary } — terminal failure
          if (status === "error") {
            terminalSeen = true;
            push({
              kind: "event",
              value: {
                type: "chat_error",
                message:
                  (payload?.summary as string) ?? "Agent execution failed",
              },
            });
            push({ kind: "done" });
            return;
          }

          // Unexpected status — log and treat as error
          terminalSeen = true;
          log.warn(
            {
              event: EVENT_NAMES.ADAPTER_OPENCLAW_GATEWAY_ERROR,
              agentRequestId,
              status,
              reasonCode: "unexpected_status",
            },
            EVENT_NAMES.ADAPTER_OPENCLAW_GATEWAY_ERROR
          );
          push({
            kind: "event",
            value: {
              type: "chat_error",
              message: `Unexpected gateway response status: ${status}`,
            },
          });
          push({ kind: "done" });
          return;
        }

        // ── Chat events: delta, final (signal), error, aborted ───────
        // WS_EVENT_CAUSALITY: only process chat events for OUR session.
        // The gateway broadcasts chat events to all connected WS clients,
        // so heartbeat runs, other users' runs, etc. arrive here too.
        // Hard filter: drop any frame whose sessionKey doesn't match ours.
        if (frame.type === "event" && frame.event === "chat") {
          const payload = frame.payload as Record<string, unknown> | undefined;
          const frameSessionKey = payload?.sessionKey as string | undefined;
          if (!frameSessionKey || frameSessionKey !== opts.sessionKey) {
            return; // Missing or mismatched sessionKey — drop
          }
          const state = payload?.state as string | undefined;

          if (state === "delta") {
            const accumulated = extractTextFromMessage(payload);
            // Regression guard: if accumulated shrinks (shouldn't happen), reset
            if (accumulated.length < prevText.length) {
              prevText = "";
            }
            if (accumulated.length > prevText.length) {
              const diff = accumulated.slice(prevText.length);
              prevText = accumulated;
              push({
                kind: "event",
                value: { type: "text_delta", text: diff },
              });
            }
            return;
          }

          // Chat final is a SIGNAL only — NOT terminal.
          // The authoritative content comes in the final "ok" res frame.
          if (state === "final") {
            return;
          }

          // Error/aborted — terminal failure
          if (state === "error" || state === "aborted") {
            terminalSeen = true;
            const errorMessage =
              (payload?.errorMessage as string) ??
              `Agent ${state === "aborted" ? "aborted" : "error"}`;
            push({
              kind: "event",
              value: { type: "chat_error", message: errorMessage },
            });
            push({ kind: "done" });
            return;
          }
        }

        // ── Agent events: lifecycle, tool, compaction ───────
        // STATUS_SESSIONKEY_FILTERED: same sessionKey filter as chat events.
        // STATUS_BEST_EFFORT: these are informational — drop silently on mismatch.
        if (frame.type === "event" && frame.event === "agent") {
          const payload = frame.payload as Record<string, unknown> | undefined;
          const frameSessionKey = payload?.sessionKey as string | undefined;
          if (!frameSessionKey || frameSessionKey !== opts.sessionKey) {
            return; // Missing or mismatched sessionKey — drop
          }

          const stream = payload?.stream as string | undefined;
          const data = payload?.data as Record<string, unknown> | undefined;
          const phase = data?.phase as string | undefined;

          if (stream === "lifecycle" && phase === "start") {
            push({
              kind: "event",
              value: { type: "status", phase: "thinking" },
            });
            return;
          }

          if (stream === "tool") {
            if (phase === "start") {
              // STATUS_NEVER_LEAKS_CONTENT: only tool name, never args or results
              const toolName = data?.name as string | undefined;
              push({
                kind: "event",
                value: {
                  type: "status",
                  phase: "tool_use",
                  ...(toolName ? { label: toolName } : {}),
                },
              });
            } else if (phase === "end") {
              push({
                kind: "event",
                value: { type: "status", phase: "thinking" },
              });
            }
            return;
          }

          if (stream === "compaction") {
            if (phase === "start") {
              push({
                kind: "event",
                value: { type: "status", phase: "compacting" },
              });
            } else if (phase === "end") {
              push({
                kind: "event",
                value: { type: "status", phase: "thinking" },
              });
            }
            return;
          }

          // Drop assistant (redundant with chat delta) and error (handled by chat_error)
          return;
        }

        // Ignore other events (tick, health, etc.)
      });

      // Pull loop: yield events from the queue
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            notify = r;
          });
        }

        while (queue.length > 0) {
          // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 guarantees shift() returns
          const item = queue.shift()!;
          if (item.kind === "done") return;
          if (item.kind === "error") throw item.error;
          if (item.kind === "heartbeat") {
            const elapsedMs = Date.now() - startTime;
            log.warn(
              { elapsedMs, timeoutMs },
              "Gateway agent still waiting for response"
            );
            continue;
          }
          if (item.kind === "ws_closed") {
            if (terminalSeen) {
              // Normal: WS closed after we already processed the terminal frame
              return;
            }
            // Abnormal: WS closed before terminal frame — surface as error
            log.error(
              {
                event: EVENT_NAMES.ADAPTER_OPENCLAW_GATEWAY_ERROR,
                reasonCode: "ws_closed_before_terminal",
                elapsedMs: Date.now() - startTime,
              },
              EVENT_NAMES.ADAPTER_OPENCLAW_GATEWAY_ERROR
            );
            throw new Error(
              "Gateway WebSocket closed before agent response completed"
            );
          }
          yield item.value;
        }
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeatInterval);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  }

  /**
   * Configure per-session settings via WS sessions.patch.
   * Opens a connection, performs handshake, sends patch, closes.
   *
   * @param model - Model override (e.g. "cogni/test-model").
   *   Sets session-level modelOverride via OpenClaw's sessions.patch handler.
   */
  async configureSession(
    sessionKey: string,
    outboundHeaders: Record<string, string>,
    model: string
  ): Promise<void> {
    const wsUrl = this.gatewayUrl.replace(/^http/, "ws");
    this.log.debug(
      { sessionKey, headerCount: Object.keys(outboundHeaders).length },
      "Configuring session outbound headers"
    );

    return new Promise<void>((resolve, reject) => {
      let nextId = 0;
      const allocId = () => String(++nextId);
      let handshakeComplete = false;

      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Session patch timed out"));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timer);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };

      ws.on("error", (err) => {
        cleanup();
        reject(new Error(`Gateway WS error: ${err.message}`));
      });

      ws.on("close", () => {
        clearTimeout(timer);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as GatewayFrame;
        } catch {
          cleanup();
          reject(new Error("Failed to parse gateway frame"));
          return;
        }

        if (!handshakeComplete) {
          if (frame.type === "event" && frame.event === "connect.challenge") {
            const connectId = allocId();
            ws.send(
              JSON.stringify({
                type: "req",
                id: connectId,
                method: "connect",
                params: {
                  minProtocol: 3,
                  maxProtocol: 3,
                  client: {
                    id: "gateway-client",
                    version: "1.0.0",
                    platform: "node",
                    mode: "backend",
                  },
                  auth: { token: this.token },
                },
              })
            );
            return;
          }

          if (frame.type === "res") {
            if (!frame.ok) {
              cleanup();
              reject(
                new Error(
                  `Gateway auth failed: ${frame.error?.message ?? "unknown"}`
                )
              );
              return;
            }

            handshakeComplete = true;

            // Send sessions.patch — uses `key` not `sessionKey`
            const patchId = allocId();
            ws.send(
              JSON.stringify({
                type: "req",
                id: patchId,
                method: "sessions.patch",
                params: { key: sessionKey, outboundHeaders, model },
              })
            );
            return;
          }
          return;
        }

        // Post-handshake: waiting for patch response
        if (frame.type === "res") {
          cleanup();
          if (!frame.ok) {
            reject(
              new Error(
                `sessions.patch failed: ${frame.error?.message ?? "unknown"}`
              )
            );
            return;
          }
          resolve();
        }
      });
    });
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Perform the 3-step handshake: challenge → connect(auth) → hello-ok.
   * Sets up WS error/close handlers that push to the channel.
   * Returns an allocId function for subsequent requests.
   */
  private performHandshake(
    ws: WebSocket,
    timer: NodeJS.Timeout,
    push: (
      item:
        | { kind: "done" }
        | { kind: "error"; error: Error }
        | { kind: "event"; value: GatewayAgentEvent }
        | { kind: "ws_closed" }
    ) => void
  ): Promise<() => string> {
    let nextId = 0;
    const allocId = () => String(++nextId);

    return new Promise<() => string>((resolve, reject) => {
      const handshakeTimer = setTimeout(() => {
        reject(new Error("Gateway handshake timed out"));
      }, 10_000);

      ws.on("error", (err) => {
        clearTimeout(handshakeTimer);
        clearTimeout(timer);
        reject(new Error(`Gateway WebSocket error: ${err.message}`));
      });

      ws.on("close", () => {
        clearTimeout(handshakeTimer);
        // Do NOT push {done} here — terminal is determined by the final res frame.
        // If WS closes before terminal, the sentinel triggers an error.
        push({ kind: "ws_closed" });
      });

      ws.on("message", (data: WebSocket.RawData) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as GatewayFrame;
        } catch {
          clearTimeout(handshakeTimer);
          reject(new Error("Failed to parse gateway frame during handshake"));
          return;
        }

        // Step 1: Server sends connect.challenge
        if (frame.type === "event" && frame.event === "connect.challenge") {
          const connectId = allocId();
          ws.send(
            JSON.stringify({
              type: "req",
              id: connectId,
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "gateway-client",
                  version: "1.0.0",
                  platform: "node",
                  mode: "backend",
                },
                auth: { token: this.token },
              },
            })
          );
          return;
        }

        // Step 3: Server responds with hello-ok (or auth failure)
        if (frame.type === "res") {
          clearTimeout(handshakeTimer);
          if (!frame.ok) {
            reject(
              new Error(
                `Gateway auth failed: ${frame.error?.message ?? "unknown"}`
              )
            );
            return;
          }
          resolve(allocId);
        }

        // Ignore other events during handshake (tick, etc.)
      });
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract text from the authoritative final res payload.
 * Shape: { result: { payloads: [{ text: "..." }], meta: {...} } }
 * Per OpenClaw server-methods/agent.ts: final "ok" res carries result from agentCommand.
 */
function extractTextFromResult(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  const result = p.result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.payloads) || r.payloads.length === 0) return "";
  const first = r.payloads[0] as Record<string, unknown> | undefined;
  if (first && typeof first.text === "string") return first.text;
  return "";
}

/**
 * Extract accumulated text from a chat delta event's message field.
 * Per OpenClaw server-chat.ts emitChatDelta, the shape is:
 *   { message: { role: "assistant", content: [{ type: "text", text: "..." }] } }
 * Used for streaming deltas only — NOT for final content extraction.
 */
function extractTextFromMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  const message = p.message;
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  if (Array.isArray(m.content) && m.content.length > 0) {
    const first = m.content[0] as Record<string, unknown> | undefined;
    if (first && typeof first.text === "string") return first.text;
  }
  return "";
}
