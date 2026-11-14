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
 *   this gates REACH. See https://cognidao.org/knowledge/observability-access-design §"Phase 0".
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
 *   - PER_SERVICE_ENVELOPE (bug.5240, supersedes APP_ONLY_ENVELOPE): the default stream stays
 *     `service="app"` — the operator-side source that has always carried the per-node `node` label.
 *     A caller may select ANY OTHER service name, and that selection additionally forces
 *     `source="lease"`: lease streams are labeled operator-side by the lease-log pump from
 *     ledger-derived identity, so `node` is trustworthy there — while operator k3s streams beyond
 *     `app` (actuator, scheduler-worker, …) stay out of reach exactly as before. Shared-infra
 *     services are still NOT node-attributable; the Phase 1 generic route remains their path.
 *     See https://cognidao.org/knowledge/node-log-proxy-contract §"Node-dev log scope envelope".
 *   - DEPLOY_EVENTS_PIN_BY_LINE (task.5400): `service=deploy` is the one exception to the stream pin.
 *     The sequencer is operator-side, so its streams carry no trustworthy per-node label; the node pin
 *     is a FORCED pipeline stage `|= "node_deploy" | json | nodeId="<id>"` placed between the selector
 *     and the caller's stages AND repeated as the LAST stage (`| nodeId="<id>"`), so a caller stage that
 *     rewrote the label cannot widen it. A line without a parseable `nodeId` (leadership events, JSON
 *     errors) is dropped by the forced filter. The selector is `{env, service="sequencer"}` with no
 *     `source="lease"` (the sequencer is not a lease stream).
 *   - CALLER_STAGES_ARE_WHOLE_STAGES (every scope): the caller's remainder after the selector must be a
 *     sequence of pipeline stages starting `|`, `|=`, `|~`, `!=` or `!~`, and may contain no
 *     `or`/`and`/`unless` (an `or nodeId=~".+"` would widen the forced label filter that precedes it:
 *     `| nodeId="<id>" or nodeId=~".+"`), no brace or unbalanced parenthesis outside a string, and no
 *     `label_format` that writes `nodeId`, `node`, `env` or `service`. Refused with `invalid_query`
 *     (400). For the stream-pinned scopes (app, lease) a filter could never widen the selector, so
 *     there this is hardening, not a fix.
 * Side-effects: none (pure)
 * Links: https://cognidao.org/knowledge/node-log-proxy-contract, https://cognidao.org/knowledge/observability-access-design
 *   ./flight-status (FLIGHT_ENVS), task.5025
 * @public
 */

import type { FlightEnv } from "@/ports";
import { FLIGHT_ENVS, isFlightEnv } from "./flight-status";

export { FLIGHT_ENVS, type FlightEnv, isFlightEnv };

/** The default Loki `service` for a node-scoped query (the operator-side `app` stream). */
export const NODE_SCOPED_SERVICE = "app";

/** The `source` label the lease-log pump stamps on every provider-lease stream (bug.5240). */
export const LEASE_LOG_SOURCE = "lease";

/**
 * The virtual `service=deploy` a node dev selects to read ITS OWN node-deploy sequencer events
 * (task.5400). It is not a Loki label value: it maps to the operator's `service="sequencer"` stream and
 * pins the node through the log line's `nodeId` field (see `scopeNodeLogQL`).
 */
export const DEPLOY_LOG_SERVICE = "deploy";

/** The operator-side Loki `service` the node-deploy sequencer process logs under. */
export const SEQUENCER_LOKI_SERVICE = "sequencer";

/** Cheap pre-filter: every node-deploy event message starts `node_deploy` (step, strike, alert, ...). */
export const DEPLOY_EVENT_LINE_FILTER = "node_deploy";

/** Defensive bound on the caller-supplied LogQL query (not a real LogQL limit). */
export const MAX_QUERY_LENGTH = 2048;

/** SDL service names are DNS labels; anything else is refused before it reaches a selector. */
const SERVICE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** True when `value` is a well-formed SDL service name a caller may select. */
export function isValidServiceName(value: string): boolean {
  return SERVICE_NAME_RE.test(value);
}

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
 * Authorize + pin a caller LogQL query to one node's streams.
 *
 * - empty query        → `{env, service, node}` (+ `source="lease"` for a non-app service)
 * - `{…} | pipeline`   → selector matchers validated (forced labels must equal, others narrow),
 *                        pipeline kept
 * - `| pipeline`       → forced selector + the pipeline
 *
 * `service` defaults to the operator-side `app` stream. Selecting any other declared service
 * (bug.5240 — e.g. a lease sidecar) additionally forces `source="lease"`, so only the
 * pump-shipped, ledger-labeled streams are reachable — never operator k3s streams.
 *
 * The returned query is safe to run with the operator's read token: it can only ever match the
 * caller's node streams, never another node, service scope, or env.
 */
export function scopeNodeLogQL(input: {
  readonly env: FlightEnv;
  readonly nodeId: string;
  readonly query?: string | undefined;
  readonly service?: string | undefined;
}): string {
  const service = input.service ?? NODE_SCOPED_SERVICE;
  if (!isValidServiceName(service)) {
    throw new ObservabilityQueryError(
      "invalid_query",
      "'service' must be a lowercase DNS-label service name"
    );
  }
  const deploy = service === DEPLOY_LOG_SERVICE;
  // What the selector is re-emitted with, and which caller values for a forced label are accepted
  // (the virtual `deploy` also accepts its stream name; both are the same, narrow-only scope).
  const forcedValues: Record<string, string> = deploy
    ? { env: input.env, service: SEQUENCER_LOKI_SERVICE }
    : {
        env: input.env,
        service,
        node: input.nodeId,
        // PER_SERVICE_ENVELOPE: beyond `app`, only pump-labeled lease streams are node-attributable.
        ...(service === NODE_SCOPED_SERVICE
          ? {}
          : { source: LEASE_LOG_SOURCE }),
      };
  const accepted = (label: string): readonly string[] | undefined => {
    const v = forcedValues[label];
    if (v === undefined) return undefined;
    return deploy && label === "service" ? [v, DEPLOY_LOG_SERVICE] : [v];
  };
  const forced = Object.entries(forcedValues).map(
    ([label, value]) => `${label}=${quote(value)}`
  );
  // DEPLOY_EVENTS_PIN_BY_LINE: the forced node pin of a deploy query, before any caller pipeline.
  const pin = deploy
    ? ` |= ${quote(DEPLOY_EVENT_LINE_FILTER)} | json | nodeId=${quote(input.nodeId)}`
    : "";
  // The same node filter again AFTER the caller's stages: a caller stage that rewrote `nodeId` can
  // only ever narrow what the first pin admitted. Only emitted when the caller added stages.
  const tail = deploy ? ` | nodeId=${quote(input.nodeId)}` : "";
  const raw = (input.query ?? "").trim();
  if (raw === "") return `{${forced.join(", ")}}${pin}`;

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
    return `{${forced.join(", ")}}${pin} ${validateCallerStages(raw)}${tail}`;
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
    const allowed = accepted(m.label);
    if (allowed === undefined) {
      narrowing.push(`${m.label}${m.op}"${m.value}"`);
      continue;
    }
    if (m.op !== "=" || !allowed.includes(m.value)) {
      throw new ObservabilityQueryError(
        "query_out_of_scope",
        `selector label '${m.label}' must be ${m.label}="${allowed[0]}" for a node-scoped query`
      );
    }
  }

  const selector = `{${[...forced, ...narrowing].join(", ")}}${pin}`;
  const pipeline = validateCallerStages(pipelineRaw);
  return pipeline === "" ? selector : `${selector} ${pipeline}${tail}`;
}

/** Labels a caller stage may never write: they carry the node/env/service pin. */
const PROTECTED_LABELS: readonly string[] = [
  "nodeId",
  "node",
  "env",
  "service",
];

/**
 * Validate the caller's pipeline remainder (CALLER_STAGES_ARE_WHOLE_STAGES) and return it trimmed.
 * String literals ("…" with escapes, `…`) are blanked first so quoted text can never trip or hide a rule.
 */
function validateCallerStages(remainder: string): string {
  const text = remainder.trim();
  if (text === "") return "";
  const bad = (why: string): never => {
    throw new ObservabilityQueryError("invalid_query", `query pipeline ${why}`);
  };

  let blanked = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"') {
      i++;
      while (i < text.length && text.charAt(i) !== '"')
        i += text.charAt(i) === "\\" ? 2 : 1;
      if (i >= text.length) bad("has an unterminated string");
      blanked += '""';
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) bad("has an unterminated string");
      i = end;
      blanked += '""';
    } else {
      blanked += c;
    }
  }

  if (!/^(\||!=|!~)/.test(blanked))
    bad("must be whole stages, each starting with |, |=, |~, != or !~");
  if (/[{}]/.test(blanked)) bad("may not contain a stream selector or braces");
  let depth = 0;
  for (const c of blanked) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (depth < 0) break;
  }
  if (depth !== 0) bad("has unbalanced parentheses");
  if (/\b(or|and|unless)\b/i.test(blanked))
    bad("may not use or/and/unless (they could widen the forced node filter)");

  for (const stage of blanked.split("|")) {
    const m = /^\s*label_format\s+(.*)$/s.exec(stage);
    if (!m) continue;
    for (const assignment of (m[1] ?? "").split(",")) {
      const target = assignment.split("=")[0]?.trim() ?? "";
      if (PROTECTED_LABELS.includes(target))
        bad(`may not write the label '${target}'`);
    }
  }
  return text;
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
