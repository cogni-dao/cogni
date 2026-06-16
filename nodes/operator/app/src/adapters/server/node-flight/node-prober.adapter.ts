// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-flight/node-prober`
 * Purpose: Real-fetch implementation of NodeProber — exercises a node's PUBLIC surface exactly as an
 *   external dev would (register an agent, run the free `poet` graph, read back runs). No cluster/GH auth.
 * Scope: HTTP I/O only. Classification rules live in the feature; this adapter just measures + reports.
 * Invariants:
 *   - PUBLIC_SURFACE_ONLY: hits https://<host>/{readyz,version,api/v1/agent/register,chat/completions,agent/runs}.
 *   - RUN_CARRIES_IS_TRUTH: a created run (runs>=1) + fast return = the substrate carried it, even if the
 *     completion errors downstream (insufficient_quota → degraded, not fail). A 60s hang with runs=0 = fail.
 * Side-effects: network I/O
 * Links: src/features/nodes/flight-status.ts, docs/guides/agent-api-validation.md
 * @public
 */

import type { NodeProber, RunCarriesResult, ServingResult } from "@/ports";

const SERVING_TIMEOUT_MS = 10_000;
/** The hang we hunt is ~60s; give a touch of headroom so a real hang reads as a timeout, not a probe abort. */
const RUN_CARRIES_TIMEOUT_MS = 70_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function readBuildSha(body: unknown): string | null {
  if (body && typeof body === "object" && "buildSha" in body) {
    const v = (body as { buildSha?: unknown }).buildSha;
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  return null;
}

export class HttpNodeProber implements NodeProber {
  async serving(host: string): Promise<ServingResult> {
    let readyzCode = 0;
    try {
      const r = await fetchWithTimeout(
        `https://${host}/readyz`,
        { method: "GET" },
        SERVING_TIMEOUT_MS
      );
      readyzCode = r.status;
    } catch {
      readyzCode = 0; // network error / timeout / edge 5xx that never connected
    }

    let buildSha: string | null = null;
    try {
      const r = await fetchWithTimeout(
        `https://${host}/version`,
        { method: "GET" },
        SERVING_TIMEOUT_MS
      );
      if (r.ok) buildSha = readBuildSha(await r.json());
    } catch {
      buildSha = null;
    }

    const status = readyzCode === 200 ? "pass" : "fail";
    return { status, readyzCode, buildSha };
  }

  async runCarries(host: string): Promise<RunCarriesResult> {
    // 1. Register a throwaway agent on the node (per-node key, free poet graph).
    let apiKey = "";
    try {
      const reg = await fetchWithTimeout(
        `https://${host}/api/v1/agent/register`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `flight-gate-${Date.now()}` }),
        },
        SERVING_TIMEOUT_MS
      );
      if (reg.ok) {
        const j: unknown = await reg.json();
        if (j && typeof j === "object" && "apiKey" in j) {
          const v = (j as { apiKey?: unknown }).apiKey;
          if (typeof v === "string") apiKey = v;
        }
      }
    } catch {
      apiKey = "";
    }
    if (!apiKey) {
      return {
        status: "fail",
        durationMs: 0,
        runs: 0,
        detail: "register-failed",
      };
    }

    // 2. Run the free poet graph. Time it: a hang (no Temporal poller / worker-401) blocks ~60s.
    const auth = { Authorization: `Bearer ${apiKey}` };
    const start = Date.now();
    let completionBody: unknown = null;
    let hung = false;
    try {
      const resp = await fetchWithTimeout(
        `https://${host}/api/v1/chat/completions`,
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            graph_name: "poet",
            messages: [{ role: "user", content: "flight-status gate ping" }],
          }),
        },
        RUN_CARRIES_TIMEOUT_MS
      );
      try {
        completionBody = await resp.json();
      } catch {
        completionBody = null; // SSE / empty — run state is read from /agent/runs below
      }
    } catch {
      hung = true; // aborted at the timeout = the hang we hunt
    }
    const durationMs = Date.now() - start;

    // 3. Did a run actually get created? This is the substrate-carried-it signal.
    const runs = await this.countRuns(host, auth);

    return classifyRunCarries({ hung, runs, durationMs, completionBody });
  }

  private async countRuns(
    host: string,
    auth: Record<string, string>
  ): Promise<number> {
    try {
      const r = await fetchWithTimeout(
        `https://${host}/api/v1/agent/runs`,
        { method: "GET", headers: auth },
        SERVING_TIMEOUT_MS
      );
      if (!r.ok) return 0;
      const j: unknown = await r.json();
      const arr = Array.isArray(j)
        ? j
        : j && typeof j === "object"
          ? ((j as Record<string, unknown>).runs ??
            (j as Record<string, unknown>).items ??
            (j as Record<string, unknown>).data)
          : undefined;
      return Array.isArray(arr) ? arr.length : 0;
    } catch {
      return 0;
    }
  }
}

/** Pure classifier — exported for unit tests. */
export function classifyRunCarries(input: {
  readonly hung: boolean;
  readonly runs: number;
  readonly durationMs: number;
  readonly completionBody: unknown;
}): RunCarriesResult {
  const { hung, runs, durationMs, completionBody } = input;

  if (hung) {
    return { status: "fail", durationMs, runs, detail: "hang:no-run" };
  }

  // A normal completion → poem/text content present.
  const content = extractContent(completionBody);
  if (content) {
    return { status: "pass", durationMs, runs, detail: "poem" };
  }

  // No content but an error → run carried IFF a run row exists (failure moved downstream of creation).
  const errCode = extractErrorCode(completionBody);
  if (runs >= 1) {
    return {
      status: "degraded",
      durationMs,
      runs,
      detail: errCode ?? "run-created:no-content",
    };
  }

  // No run, no content, didn't hang → completion rejected before run creation (auth/billing-preflight).
  return {
    status: "fail",
    durationMs,
    runs,
    detail: errCode ?? "no-run-created",
  };
}

function extractContent(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = (choices[0] as { message?: { content?: unknown } }).message;
  const c = msg?.content;
  return typeof c === "string" && c.length > 0 ? c : null;
}

function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; type?: unknown };
  if (typeof e.code === "string") return e.code;
  if (typeof e.type === "string") return e.type;
  return null;
}
