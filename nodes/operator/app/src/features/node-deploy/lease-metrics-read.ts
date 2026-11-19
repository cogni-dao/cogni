// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/lease-metrics-read`
 * Purpose: The read half of the per-lane metrics token (story.5169). A node app queries Mimir for ITS OWN series
 *   through `/api/metrics/read/api/v1/{query,query_range}` with HTTP Basic (`node UUID` : the same derived token the
 *   operator scrapes it with). The operator authenticates the lane, confines the PromQL to that lane's `node` and
 *   `env`, and forwards it to the governed Mimir datasource. No node holds a fleet-shared read key.
 * Scope: Pure functions only: Basic-auth parsing, token to env resolution, the forwarded-parameter allowlist and the
 *   PromQL scope injector. The upstream call lives in `@bootstrap/capabilities/node-metrics-read`.
 * Invariants:
 *   - SAME_TOKEN_BOTH_DIRECTIONS: the credential is `deriveLeaseMetricsToken(root, nodeId, env)`; the caller's env is
 *     the one flight env whose derivation equals the presented token. A leaked token reads one node and env only,
 *     the same scope it already exposes by serving that lane's `/api/metrics`.
 *   - PARSE_WITH_PROMETHEUS_GRAMMAR: the query is parsed by `@prometheus-io/lezer-promql`, the grammar Prometheus
 *     itself ships. Any error node, an empty query or one over `MAX_QUERY_CHARS` is refused; nothing is repaired.
 *   - NO_COMMENTS_NO_CONTROLS: a `#` comment or a control character other than tab and newline is refused. The grammar
 *     ends a comment at `\n` only, Prometheus at `\r` too, so a comment could hide a second, unscoped selector from the
 *     tree. With none, the forwarded text is exactly what the verified tree describes.
 *   - EVERY_SELECTOR_SCOPED: `node="<uuid>",env="<env>"` is spliced into EVERY VectorSelector (with or without a metric
 *     name or `{}`; inside functions, subqueries, binary operators and `@`/`offset`). PromQL matchers AND, so a series
 *     returned always carries the caller's `node` and `env`, even when the caller wrote `node="other"`. This is
 *     prom-label-proxy's semantics, in-process.
 *   - VERIFIED_AFTER_SPLICE: the output is parsed again and every VectorSelector must carry both matchers, else the
 *     query is refused. A grammar gap or a splice bug fails closed instead of leaking a series.
 *   - NO_SELECTOR_NO_SERIES: a query with no selector (`vector(1)`, `time()`, `1+1`) reads no series and is allowed.
 *   - UNSUPPORTED_REFUSED: `info()` takes a data-label selector that is not a series selector, so it cannot be scoped
 *     by splicing and is refused.
 * Side-effects: none
 * Links: app/api/metrics/read/, bootstrap/capabilities/node-metrics-read.ts, lease-metrics.ts, story.5169,
 *   https://github.com/prometheus-community/prom-label-proxy
 * @internal
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { parser } from "@prometheus-io/lezer-promql";

import {
  FLIGHT_ENVS,
  type FlightEnv,
} from "@/shared/node-registry/deploy-hosts";

import { deriveLeaseMetricsToken } from "./lease-metrics";

/** The path prefix a node's `PROMETHEUS_QUERY_URL` ends with; the Prometheus client appends `/api/v1/query[_range]`. */
export const NODE_METRICS_READ_PREFIX = "/api/metrics/read";
/** Longest PromQL accepted, in characters, before the scope is spliced in. */
export const MAX_QUERY_CHARS = 4096;
/** Most vector selectors one query may carry; bounds what the splice can add to the forwarded query. */
export const MAX_SELECTORS = 128;
/** Longest value of any forwarded parameter other than `query`. */
export const MAX_PARAM_CHARS = 64;
/** Longest `query_range` window and most points one range query may ask for (Prometheus' own per-query ceiling). */
export const MAX_RANGE_SECONDS = 7 * 24 * 3600;
export const MAX_RANGE_POINTS = 11_000;
/** The auth header cap and the token cap, as on the scrape routes. */
const MAX_AUTH_HEADER_LENGTH = 512;
const MAX_TOKEN_LENGTH = 256;

const NODE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/** The caller a valid credential resolved to. */
export interface NodeMetricsCaller {
  readonly nodeId: string;
  readonly env: FlightEnv;
}

/** The `Basic` credential of a request, or null when absent, oversized or not `<node uuid>:<token>`. */
export function parseNodeBasicAuth(
  header: string | null
): { readonly nodeId: string; readonly token: string } | null {
  if (!header || header.length > MAX_AUTH_HEADER_LENGTH) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(trimmed.slice(6).trim(), "base64").toString(
    "utf8"
  );
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const nodeId = decoded.slice(0, colon);
  const token = decoded.slice(colon + 1);
  if (!NODE_UUID_RE.test(nodeId) || !token || token.length > MAX_TOKEN_LENGTH)
    return null;
  return { nodeId, token };
}

/**
 * The caller of a Basic credential: the node named by the username and the one flight env whose derived token
 * equals the password. All envs are always compared (no early exit), each over SHA-256 digests.
 */
export function authenticateNodeMetricsRead(
  header: string | null,
  root: string
): NodeMetricsCaller | null {
  const credential = parseNodeBasicAuth(header);
  if (!credential) return null;
  const presented = sha256(credential.token);
  const matches = FLIGHT_ENVS.filter((env) =>
    timingSafeEqual(
      presented,
      sha256(deriveLeaseMetricsToken(root, credential.nodeId, env))
    )
  );
  const env = matches.length === 1 ? matches[0] : undefined;
  return env ? { nodeId: credential.nodeId, env } : null;
}

/** The Prometheus HTTP API read endpoints a node may call. */
export type NodeMetricsReadKind = "query" | "query_range";

const FORWARDED_PARAMS: Record<NodeMetricsReadKind, readonly string[]> = {
  query: ["query", "time", "timeout"],
  query_range: ["query", "start", "end", "step", "timeout"],
};
const REQUIRED_PARAMS: Record<NodeMetricsReadKind, readonly string[]> = {
  query: ["query"],
  query_range: ["query", "start", "end", "step"],
};

export type ReadParamsResult =
  | { readonly ok: true; readonly params: Map<string, string> }
  | { readonly ok: false; readonly reason: string };

/**
 * The only parameters forwarded upstream, first value each. Anything else (`stats`, `lookback_delta`, `explain`,
 * repeated keys) is dropped. A required one missing, or any value over its cap, is refused.
 */
export function pickReadParams(
  kind: NodeMetricsReadKind,
  source: URLSearchParams
): ReadParamsResult {
  const params = new Map<string, string>();
  for (const name of FORWARDED_PARAMS[kind]) {
    const value = source.get(name);
    if (value === null) continue;
    const cap = name === "query" ? MAX_QUERY_CHARS : MAX_PARAM_CHARS;
    if (value.length > cap)
      return { ok: false, reason: `parameter ${name} too long` };
    params.set(name, value);
  }
  const missing = REQUIRED_PARAMS[kind].find((name) => !params.has(name));
  if (missing)
    return { ok: false, reason: `missing required parameter ${missing}` };
  if (kind === "query_range") {
    const refusal = rangeRefusal(
      params.get("start") ?? "",
      params.get("end") ?? "",
      params.get("step") ?? ""
    );
    if (refusal) return { ok: false, reason: refusal };
  }
  return { ok: true, params };
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

/** A Prometheus timestamp (unix seconds or RFC 3339) in seconds, or null. */
function parseTimestamp(value: string): number | null {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** A Prometheus step (float seconds or a duration such as `1h30m`) in seconds, or null. */
function parseStep(value: string): number | null {
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(value)) return null;
  let total = 0;
  for (const [, n, unit] of value.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g))
    total += Number(n) * (DURATION_UNIT_SECONDS[unit as string] ?? 0);
  return total;
}

/** Why a range query is refused before it reaches the shared datasource, or null. */
function rangeRefusal(start: string, end: string, step: string): string | null {
  const from = parseTimestamp(start);
  const to = parseTimestamp(end);
  const every = parseStep(step);
  if (from === null || to === null || every === null || every <= 0)
    return "start, end and step must be timestamps and a positive step";
  const span = to - from;
  if (span < 0) return "end before start";
  if (span > MAX_RANGE_SECONDS) return "range longer than 7d";
  if (span / every > MAX_RANGE_POINTS) return "too many points";
  return null;
}

// --- PromQL scope injector ---------------------------------------------------------------------------------------

type Tree = ReturnType<typeof parser.parse>;
type SyntaxNode = Tree["topNode"];

export type ScopeRefusal =
  | "empty"
  | "too_long"
  | "syntax"
  | "unsupported_function"
  | "too_many_selectors"
  | "scope_unverified";

export type ScopeResult =
  | {
      readonly ok: true;
      readonly query: string;
      /** How many vector selectors were scoped. */
      readonly selectors: number;
    }
  | { readonly ok: false; readonly reason: ScopeRefusal };

export interface QueryScope {
  readonly nodeId: string;
  readonly env: string;
}

const MATCHER_NODES = new Set([
  "UnquotedLabelMatcher",
  "QuotedLabelMatcher",
  "QuotedLabelName",
]);

/**
 * Control characters other than tab and newline: `\r`, `\v`, `\f`, NUL, DEL, the C1 block (U+0080-009F, which has
 * NEL) and U+2028/2029. Prometheus and the grammar disagree on which of these end a line or a token.
 */
const hasForbiddenControl = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c < 0x20 && c !== 0x09 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029
    )
      return true;
  }
  return false;
};

/**
 * True when the tree has an error node or a `#` comment. The grammar ends a comment only at `\n`; Prometheus also
 * ends it at `\r`, so `foo #\r or foo` is ONE selector to the grammar and two to Prometheus (an unscoped second
 * arm). A query with a comment is refused outright, so the text forwarded is exactly the text the tree describes.
 */
const hasErrorOrComment = (tree: Tree): boolean => {
  let found = false;
  tree.iterate({
    enter(node) {
      if (node.type.isError || node.name === "LineComment") found = true;
      return !found;
    },
  });
  return found;
};

const selectorsOf = (tree: Tree): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "VectorSelector") out.push(node.node);
    },
  });
  return out;
};

const hasFunction = (tree: Tree, name: string): boolean => {
  let found = false;
  tree.iterate({
    enter(node) {
      if (node.name === name) found = true;
      return !found;
    },
  });
  return found;
};

const childrenOf = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};

const matchersText = (scope: QueryScope): string =>
  `node="${scope.nodeId}",env="${scope.env}"`;

/** One splice: where to insert, and what. */
interface Splice {
  readonly at: number;
  readonly text: string;
}

function spliceFor(source: string, selector: SyntaxNode, scope: QueryScope) {
  const added = matchersText(scope);
  const matchers = childrenOf(selector).find((c) => c.name === "LabelMatchers");
  // `foo` or a selector with no braces: add a brace pair after the metric name.
  if (!matchers) return { at: selector.to, text: `{${added}}` } as Splice;
  const close = matchers.to - 1;
  if (source[close] !== "}") return null;
  const parts = childrenOf(matchers);
  const last = parts.filter((c) => MATCHER_NODES.has(c.name)).at(-1);
  if (!last) return { at: close, text: added } as Splice;
  // A trailing comma is legal (`{a="b",}`): reuse it instead of writing `,,`. No comment can sit in the gap.
  const gap = source.slice(last.to, close);
  return { at: close, text: `${gap.includes(",") ? "" : ","}${added}` };
}

/** True when `selector` carries `<name>="<value>"` as one of its matchers. */
function carries(
  source: string,
  selector: SyntaxNode,
  name: string,
  value: string
): boolean {
  const matchers = childrenOf(selector).find((c) => c.name === "LabelMatchers");
  if (!matchers) return false;
  return childrenOf(matchers).some((m) => {
    if (m.name !== "UnquotedLabelMatcher") return false;
    const parts = childrenOf(m);
    const label = parts.find((p) => p.name === "LabelName");
    const op = parts.find((p) => p.name === "MatchOp");
    const literal = parts.find((p) => p.name === "StringLiteral");
    return (
      !!label &&
      !!op &&
      !!literal &&
      source.slice(label.from, label.to) === name &&
      source.slice(op.from, op.to) === "=" &&
      source.slice(literal.from, literal.to) === `"${value}"`
    );
  });
}

/**
 * True when `query` parses cleanly and EVERY vector selector in it carries `node="<nodeId>"` and `env="<env>"`.
 * Used on the spliced output before it is forwarded, and by the tests to walk an output tree.
 */
export function everySelectorScoped(query: string, scope: QueryScope): boolean {
  if (hasForbiddenControl(query)) return false;
  const tree = parser.parse(query);
  if (hasErrorOrComment(tree)) return false;
  return selectorsOf(tree).every(
    (s) =>
      carries(query, s, "node", scope.nodeId) &&
      carries(query, s, "env", scope.env)
  );
}

/**
 * Confine `query` to one lane's series. Pure; the result is either the rewritten query or a bounded refusal.
 * Splices run right to left over tree positions, so earlier offsets stay valid.
 */
export function scopePromQuery(query: string, scope: QueryScope): ScopeResult {
  if (query.trim() === "") return { ok: false, reason: "empty" };
  if (query.length > MAX_QUERY_CHARS) return { ok: false, reason: "too_long" };
  if (hasForbiddenControl(query)) return { ok: false, reason: "syntax" };
  const tree = parser.parse(query);
  if (hasErrorOrComment(tree)) return { ok: false, reason: "syntax" };
  if (hasFunction(tree, "Info"))
    return { ok: false, reason: "unsupported_function" };
  const selectors = selectorsOf(tree);
  if (selectors.length > MAX_SELECTORS)
    return { ok: false, reason: "too_many_selectors" };

  const splices: Splice[] = [];
  for (const selector of selectors) {
    const splice = spliceFor(query, selector, scope);
    if (!splice) return { ok: false, reason: "scope_unverified" };
    splices.push(splice);
  }
  let out = query;
  for (const { at, text } of splices.sort((a, b) => b.at - a.at))
    out = `${out.slice(0, at)}${text}${out.slice(at)}`;

  if (!everySelectorScoped(out, scope))
    return { ok: false, reason: "scope_unverified" };
  return { ok: true, query: out, selectors: selectors.length };
}
