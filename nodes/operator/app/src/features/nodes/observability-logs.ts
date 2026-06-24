// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/observability-logs`
 * Purpose: The security core of the node-pinned log-read PROXY (task.5025 / north-star ②).
 *   A node dev sends the **same full LogQL** they would paste into `scripts/loki-query.sh` / the
 *   Grafana MCP. The operator does not BUILD the selector for them — it AUTHORIZES the query's reach:
 *   it parses the leading stream selector, forces `env`/`service`/`node` to the caller's node, lets
 *   any further label matcher only NARROW, and passes the LogQL pipeline through verbatim. 1:1 with
 *   the operator-scope log path for the caller's slice; the OpenFGA check (in the route) gates WHO,
 *   this gates REACH. See docs/design/substrate-grafana-observability.md §"Phase 0".
 * Scope: Pure — no network, no auth, no env. The route does auth/RBAC; the adapter does IO.
 * Invariants:
 *   - ENV_FROM_CANONICAL: the env set is the shared `FLIGHT_ENVS` (the envs a node deploys to) — NOT a
 *     local copy. Adding a deploy env updates one place; this proxy follows automatically.
 *   - SELECTOR_IS_REBUILT: the returned stream selector is re-emitted from parsed matchers, never the
 *     caller's raw selector text — `env`/`service`/`node` are forced, so a caller cannot break out of
 *     the node pin. A pipeline cannot add streams in LogQL, so it is passed through verbatim.
 *   - SELECTOR_LABELS_NARROW_ONLY: a caller `env`/`service`/`node` matcher must EQUAL the forced value
 *     (else `query_out_of_scope`); any other label matcher (`pod`, `stream`, `source`, …) is kept as an
 *     additional narrowing matcher.
 *   - APP_ONLY_ENVELOPE: `service` is fixed to `app` because the node app pod is the ONLY log source
 *     carrying the per-node `node` label today. Shared-infra services (scheduler-worker, temporal,
 *     litellm) are NOT node-attributable yet (they bind no `nodeId`), so they are deliberately out of
 *     scope — surfacing them here would leak cross-node lines. Multi-service/-scope access is the
 *     Phase 1 generic route. See docs/spec/grafana-observability-access.md §"Node-dev log scope envelope".
 * Side-effects: none (pure)
 * Links: docs/spec/grafana-observability-access.md, docs/design/substrate-grafana-observability.md,
 *   ./flight-status (FLIGHT_ENVS), task.5025
 * @public
 */

import type { FlightEnv } from "@/ports";
import { FLIGHT_ENVS, isFlightEnv } from "./flight-status";

export { FLIGHT_ENVS, type FlightEnv, isFlightEnv };

/** The only Loki `service` that carries the per-node `node` label today (the node's app pod). */
export const NODE_SCOPED_SERVICE = "app";

/** Defensive bound on the caller-supplied LogQL query (not a real LogQL limit). */
export const MAX_QUERY_LENGTH = 2048;

/** The selector labels the operator forces to the caller's node — a caller matcher may only match them. */
const FORCED_LABELS = new Set(["env", "service", "node"]);

export type ObservabilityQueryErrorCode =
  | "invalid_query"
  | "query_out_of_scope"
  | "invalid_window";

/** Thrown when the caller-supplied query/window cannot be parsed or would reach beyond the node (→ HTTP 400). */
export class ObservabilityQueryError extends Error {
  constructor(
    readonly code: ObservabilityQueryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ObservabilityQueryError";
  }
}

interface LabelMatcher {
  readonly label: string;
  readonly op: "=" | "!=" | "=~" | "!~";
  /** The inner (already LogQL-escaped) value, without the surrounding quotes. */
  readonly value: string;
}

/**
 * Authorize + pin a caller LogQL query to one node's app stream.
 *
 * - empty query        → `{env, service="app", node}` (just this node's app lines)
 * - `{…} | pipeline`   → selector matchers validated (env/service/node forced, others narrow), pipeline kept
 * - `| pipeline`       → forced selector + the pipeline
 *
 * The returned query is safe to run with the operator's read token: it can only ever match the
 * caller's node app stream, never another node, service, or env.
 */
export function scopeNodeLogQL(input: {
  readonly env: FlightEnv;
  readonly nodeId: string;
  readonly query?: string | undefined;
}): string {
  const forced = forcedSelectorParts(input.env, input.nodeId);
  const raw = (input.query ?? "").trim();
  if (raw === "") return `{${forced.join(", ")}}`;

  if (raw.length > MAX_QUERY_LENGTH) {
    throw new ObservabilityQueryError(
      "invalid_query",
      `query exceeds ${MAX_QUERY_LENGTH} chars`
    );
  }

  // Pipeline-only convenience form: no leading stream selector.
  if (!raw.startsWith("{")) {
    if (raw.includes("{") || raw.includes("}")) {
      throw new ObservabilityQueryError(
        "invalid_query",
        "query must begin with a stream selector {…} or be a bare LogQL pipeline"
      );
    }
    return `{${forced.join(", ")}} ${raw}`;
  }

  // Full LogQL: split the leading stream selector from the trailing pipeline.
  const selectorMatch = /^\{([^{}]*)\}(.*)$/s.exec(raw);
  if (!selectorMatch) {
    throw new ObservabilityQueryError(
      "invalid_query",
      "stream selector is not a single balanced {…} block"
    );
  }
  // Regex capture groups are always present on a match; coerce for noUncheckedIndexedAccess.
  const matchersRaw = selectorMatch[1] ?? "";
  const pipelineRaw = selectorMatch[2] ?? "";

  const narrowing: string[] = [];
  for (const m of parseMatchers(matchersRaw)) {
    if (!FORCED_LABELS.has(m.label)) {
      narrowing.push(`${m.label}${m.op}"${m.value}"`);
      continue;
    }
    const required =
      m.label === "env"
        ? input.env
        : m.label === "service"
          ? NODE_SCOPED_SERVICE
          : input.nodeId;
    if (m.op !== "=" || m.value !== required) {
      throw new ObservabilityQueryError(
        "query_out_of_scope",
        `selector label '${m.label}' must be ${m.label}="${required}" for a node-scoped query`
      );
    }
  }

  const selector = `{${[...forced, ...narrowing].join(", ")}}`;
  const pipeline = pipelineRaw.trim();
  return pipeline === "" ? selector : `${selector} ${pipeline}`;
}

function forcedSelectorParts(env: FlightEnv, nodeId: string): string[] {
  return [
    `env=${quote(env)}`,
    `service=${quote(NODE_SCOPED_SERVICE)}`,
    `node=${quote(nodeId)}`,
  ];
}

/** Parse the comma-separated label matchers inside a stream selector; reject anything unparseable. */
function parseMatchers(matchersRaw: string): LabelMatcher[] {
  const matcherRe =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|=|!=)\s*"((?:[^"\\]|\\.)*)"/g;
  const matchers: LabelMatcher[] = [];
  let residue = matchersRaw;
  let m: RegExpExecArray | null = matcherRe.exec(matchersRaw);
  while (m !== null) {
    matchers.push({
      label: m[1] ?? "",
      op: (m[2] ?? "=") as LabelMatcher["op"],
      value: m[3] ?? "",
    });
    residue = residue.replace(m[0], "");
    m = matcherRe.exec(matchersRaw);
  }
  // Everything left over must be commas/whitespace — otherwise a matcher was malformed.
  if (residue.replace(/[\s,]/g, "") !== "") {
    throw new ObservabilityQueryError(
      "invalid_query",
      "stream selector contains an unparseable label matcher"
    );
  }
  return matchers;
}

/** Double-quote a LogQL label value, escaping `\` and `"`. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── Time window ────────────────────────────────────────────────────────────
// The proxy queries Loki over a bounded window. Two mutually-exclusive forms:
//   - relative: `minutes` back from now (default 60, max 1440)   ← the existing knob
//   - absolute: `start`/`end` instants (RFC3339 or epoch-ms)     ← loki-query.sh parity
// Either form is clamped to a 24h max span: a single dev query never scans more
// of Loki than the operator-scope path would. Absolute beats relative when both
// are present.

/** Relative-window bounds (minutes). Owned here so the route holds no window math. */
export const DEFAULT_MINUTES = 60;
export const MAX_MINUTES = 24 * 60;
/** Hard cap on any single query's span — relative or absolute. */
export const MAX_WINDOW_MS = MAX_MINUTES * 60_000;

const msToNs = (ms: number): string => `${ms}000000`;

/** Parse an instant as either epoch-milliseconds (all digits) or an RFC3339/ISO-8601 string. */
function parseInstantMs(raw: string, label: string): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (Number.isSafeInteger(ms) && ms >= 0) return ms;
  } else {
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return ms;
  }
  throw new ObservabilityQueryError(
    "invalid_window",
    `'${label}' must be an RFC3339 timestamp or epoch-milliseconds integer`
  );
}

function clampMinutes(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MINUTES;
  return Math.min(n, MAX_MINUTES);
}

/**
 * Resolve the Loki query window (nanosecond `startNs`/`endNs`) from the caller's params.
 *
 * - no `start`/`end`        → relative: `[now - minutes, now]` (minutes clamped to ≤24h)
 * - `start` and/or `end`    → absolute: each parsed as RFC3339 or epoch-ms; missing `end`
 *                             defaults to now, missing `start` to `end - 1h`
 *
 * Throws `ObservabilityQueryError('invalid_window')` on an unparseable instant,
 * `start >= end`, or a span exceeding `MAX_WINDOW_MS`.
 */
export function resolveLogWindow(input: {
  readonly nowMs: number;
  readonly minutes?: string | null;
  readonly start?: string | null;
  readonly end?: string | null;
}): { startNs: string; endNs: string } {
  const hasAbsolute =
    (input.start ?? "").trim() !== "" || (input.end ?? "").trim() !== "";

  if (!hasAbsolute) {
    const minutes = clampMinutes(input.minutes);
    return {
      startNs: msToNs(input.nowMs - minutes * 60_000),
      endNs: msToNs(input.nowMs),
    };
  }

  const endMs =
    (input.end ?? "").trim() !== ""
      ? parseInstantMs(input.end as string, "end")
      : input.nowMs;
  const startMs =
    (input.start ?? "").trim() !== ""
      ? parseInstantMs(input.start as string, "start")
      : endMs - DEFAULT_MINUTES * 60_000;

  if (startMs >= endMs) {
    throw new ObservabilityQueryError(
      "invalid_window",
      "'start' must be before 'end'"
    );
  }
  if (endMs - startMs > MAX_WINDOW_MS) {
    throw new ObservabilityQueryError(
      "invalid_window",
      `window span exceeds the ${MAX_MINUTES / 60}h maximum`
    );
  }
  return { startNs: msToNs(startMs), endNs: msToNs(endMs) };
}
