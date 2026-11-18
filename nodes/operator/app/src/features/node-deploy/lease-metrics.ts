// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/lease-metrics`
 * Purpose: Makes "deployed via operator => request metrics in Mimir" a structural property (bug.5641). The
 *   operator scrapes every serving lane's public `/api/metrics` and serves ONE merged Prometheus exposition,
 *   which the env's Alloy scrapes and ships with its existing credential. Akash leases have no Alloy and no
 *   daemonset; this is the control-plane counterpart of the lease-log pump, for metrics.
 * Scope: The scrape token derivation, the exposition merge with operator-stamped labels, the scrape synthetic
 *   series, and the bounded fan-out. IO lives behind the injected `fetchLane` seam.
 * Invariants:
 *   - TOKEN_IS_DERIVED: a lane's scrape token is `HMAC-SHA256(operator METRICS_TOKEN, "metrics-scrape:v1:<nodeId>:<env>")`
 *     in hex. The sequencer puts it in the lease env as `METRICS_TOKEN`; the operator recomputes it here. No node
 *     bucket is read, and one leaked token reads one node's metrics only.
 *   - TRUSTED_LABELS_OPERATOR_SIDE: `node` (repo-spec UUID), `env`, `workload` and `service` are stamped from the
 *     release store, and any such label the tenant app wrote is removed first. A tenant cannot forge its identity.
 *   - ABSENCE_IS_VISIBLE: every lane yields `cogni_lease_scrape_up{...}` (1 or 0 with a bounded `reason`) and
 *     `cogni_lease_scrape_duration_seconds`, so a dead, unauthorised or not-yet-released lane reads 0, never missing.
 *     A tenant sample named `cogni_lease_scrape_*` is dropped.
 *   - FAIL_OPEN_PER_LANE: one slow, huge or broken lane fails alone and never blocks the others.
 *   - BOUNDED: lanes, concurrency, per-lane time and bytes have caps; the output cannot grow without bound.
 * Side-effects: none (IO via the injected seam)
 * Links: ports/delivery-kpi.port.ts, app/api/metrics/leases/route.ts, infra/compose/runtime/configs/alloy-config.metrics.alloy,
 *   https://cognidao.org/knowledge/lease-metrics-forwarding-design, bug.5641
 * @internal
 */

import { createHmac } from "node:crypto";

/** The path every node app serves its Prometheus exposition on. */
export const LEASE_METRICS_PATH = "/api/metrics";
/** Most lanes one scrape fans out to (the same bound as the lane probes). */
export const MAX_LEASE_LANES = 64;
/** Lanes scraped in parallel. */
export const LEASE_SCRAPE_CONCURRENCY = 8;
/** Per-lane deadline. */
export const LEASE_SCRAPE_TIMEOUT_MS = 4_000;
/** Largest accepted body per lane, in bytes. A body at the cap counts as too large. */
export const LEASE_SCRAPE_MAX_BYTES = 2_000_000;
/** Most samples one lane may contribute. More reads as too large: one tenant cannot flood the fleet's series quota. */
export const LEASE_SCRAPE_MAX_SAMPLES = 20_000;

const TOKEN_MESSAGE_PREFIX = "metrics-scrape:v1";

/** The scrape token of one lane. Same inputs always give the same token. */
export function deriveLeaseMetricsToken(
  root: string,
  nodeId: string,
  env: string
): string {
  return createHmac("sha256", root)
    .update(`${TOKEN_MESSAGE_PREFIX}:${nodeId}:${env}`, "utf8")
    .digest("hex");
}

export interface LeaseScrapeLane {
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
  readonly host: string;
}

/** Bounded outcome enum of one lane scrape. */
export type LeaseScrapeReason =
  | "ok"
  | "unauthorized"
  | "not_configured"
  | "not_found"
  | "http_error"
  | "timeout"
  | "network"
  | "invalid_target"
  | "too_large"
  | "empty";

export type LeaseFetchResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
    }
  | { readonly kind: "unreachable"; readonly code: string };

export interface LeaseMetricsDeps {
  /** GET `https://<host>/api/metrics` with `Authorization: Bearer <token>`. Never follows redirects. */
  readonly fetchLane: (
    lane: LeaseScrapeLane,
    token: string,
    signal: AbortSignal
  ) => Promise<LeaseFetchResult>;
  readonly now?: () => number;
}

export interface LeaseMetricsInput {
  /** The operator's own `METRICS_TOKEN`: the derivation root. */
  readonly root: string;
  readonly lanes: readonly LeaseScrapeLane[];
  /** The lane read hit its row bound: some lanes are not scraped. */
  readonly truncated: boolean;
  readonly signal: AbortSignal;
}

export interface LeaseScrapeOutcome {
  readonly lane: LeaseScrapeLane;
  readonly reason: LeaseScrapeReason;
  readonly durationSeconds: number;
  /** Raw exposition text when `reason` is `ok`. */
  readonly body?: string | undefined;
}

export interface LeaseMetricsReport {
  readonly text: string;
  readonly lanes: number;
  readonly scraped: number;
  readonly failed: number;
  readonly truncated: boolean;
  readonly reasons: Readonly<Record<string, number>>;
}

/** Non-empty, non-comment lines: the most samples the body can hold. */
function countSampleLines(body: string): number {
  let n = 0;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t !== "" && !t.startsWith("#")) n += 1;
  }
  return n;
}

function classify(result: LeaseFetchResult): LeaseScrapeReason {
  if (result.kind === "unreachable") {
    return result.code === "timeout" ||
      result.code === "network" ||
      result.code === "invalid_target"
      ? result.code
      : "network";
  }
  if (result.status === 200) {
    return Buffer.byteLength(result.body, "utf8") >= LEASE_SCRAPE_MAX_BYTES ||
      countSampleLines(result.body) > LEASE_SCRAPE_MAX_SAMPLES
      ? "too_large"
      : "ok";
  }
  if (result.status === 401) return "unauthorized";
  if (result.status === 500) return "not_configured";
  if (result.status === 404) return "not_found";
  return "http_error";
}

async function scrapeLane(
  lane: LeaseScrapeLane,
  root: string,
  signal: AbortSignal,
  deps: LeaseMetricsDeps
): Promise<LeaseScrapeOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  let reason: LeaseScrapeReason;
  let body: string | undefined;
  try {
    const result = await deps.fetchLane(
      lane,
      deriveLeaseMetricsToken(root, lane.nodeId, lane.env),
      signal
    );
    reason = classify(result);
    if (reason === "ok" && result.kind === "response") body = result.body;
  } catch {
    // The caller's budget ran out, or the seam threw: this lane read as down, the rest are unaffected.
    reason = "timeout";
  }
  return {
    lane,
    reason,
    durationSeconds: Math.max(0, now() - started) / 1000,
    body,
  };
}

/** Scrape every lane with bounded concurrency. Never throws. */
export async function scrapeLeases(
  input: LeaseMetricsInput,
  deps: LeaseMetricsDeps
): Promise<LeaseScrapeOutcome[]> {
  const lanes = input.lanes.slice(0, MAX_LEASE_LANES);
  const out: LeaseScrapeOutcome[] = new Array(lanes.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < lanes.length; i = next++) {
      out[i] = await scrapeLane(
        lanes[i] as LeaseScrapeLane,
        input.root,
        input.signal,
        deps
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(LEASE_SCRAPE_CONCURRENCY, lanes.length) },
      worker
    )
  );
  return out;
}

// ---------------------------------------------------------------------------
// Exposition merge
// ---------------------------------------------------------------------------

/** Label names the operator owns. A tenant sample's own value for any of them is dropped. */
const OPERATOR_LABELS: ReadonlySet<string> = new Set([
  "node",
  "env",
  "workload",
  "service",
  // Target identity labels. Alloy keeps tenant labels (`honor_labels`), so a tenant `job` or `instance` would
  // re-label its series as another scrape job (for example the deadman's `integrations/unix`).
  "job",
  "instance",
]);
const SYNTHETIC_PREFIX = "cogni_lease_scrape_";
/**
 * Metric names the platform's own health rules read. A tenant sample under one is dropped: its series would carry
 * the lane's `env` and join the min/max/count the rules compute over the platform's own series.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "up",
  "ALERTS",
  "ALERTS_FOR_STATE",
]);
const RESERVED_PREFIXES: readonly string[] = [
  SYNTHETIC_PREFIX,
  "scrape_",
  "node_",
  "container_",
  "kube_",
  "probe_",
  "pg_",
  "postgres_",
];
function isReservedName(name: string): boolean {
  return (
    RESERVED_NAMES.has(name) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}
/** A longer line is dropped before any parsing, so no tenant line can cost more than a bounded scan. */
export const MAX_LINE_CHARS = 4096;
/** Most labels one sample may carry. */
const MAX_LABELS = 32;
const SAMPLE_START = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
/** A float (no ambiguous grouping, so linear), `NaN`, or `Inf` with an optional sign. */
const SAMPLE_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SAMPLE_SPECIAL = /^(?:NaN|[+-]?Inf)$/;
const SAMPLE_TIMESTAMP = /^-?\d{1,20}$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** `<value>[ <timestamp>]` after the labels, rebuilt from validated tokens. Undefined when it is not a sample tail. */
function sampleTail(rest: string): string | undefined {
  if (!/^\s/.test(rest)) return undefined;
  const tokens = rest.trim().split(/\s+/);
  const [value, timestamp] = tokens;
  if (
    tokens.length > 2 ||
    value === undefined ||
    !(SAMPLE_NUMBER.test(value) || SAMPLE_SPECIAL.test(value)) ||
    (timestamp !== undefined && !SAMPLE_TIMESTAMP.test(timestamp))
  )
    return undefined;
  return timestamp === undefined ? ` ${value}` : ` ${value} ${timestamp}`;
}

/** Escape a label value for the text exposition format. */
export function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Split `name{a="b",c="d"} 1 123` into its name, its raw label pairs and the rest after the closing brace.
 * Returns undefined for a line this scanner does not understand (it is then dropped, never forwarded raw).
 */
function splitSample(line: string):
  | {
      readonly name: string;
      readonly labels: readonly (readonly [string, string])[];
      readonly rest: string;
    }
  | undefined {
  const nameMatch = SAMPLE_START.exec(line);
  if (!nameMatch) return undefined;
  const name = nameMatch[0];
  let i = name.length;
  if (line[i] !== "{") {
    const rest = sampleTail(line.slice(i));
    return rest === undefined ? undefined : { name, labels: [], rest };
  }
  i += 1;
  const labels: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  while (i < line.length) {
    while (line[i] === " " || line[i] === ",") i += 1;
    if (line[i] === "}") {
      const rest = sampleTail(line.slice(i + 1));
      return rest === undefined ? undefined : { name, labels, rest };
    }
    if (labels.length >= MAX_LABELS) return undefined;
    const eq = line.indexOf("=", i);
    if (eq < 0) return undefined;
    const labelName = line.slice(i, eq).trim();
    if (
      !LABEL_NAME.test(labelName) ||
      labelName.startsWith("__") ||
      seen.has(labelName) ||
      line[eq + 1] !== '"'
    )
      return undefined;
    let j = eq + 2;
    let raw = "";
    for (; j < line.length; j += 1) {
      const c = line[j];
      if (c === "\\") {
        const next = line[j + 1];
        // Only the three escapes the text format defines; anything else is a parse error downstream.
        if (next !== "\\" && next !== '"' && next !== "n") return undefined;
        raw += `${c}${next}`;
        j += 1;
      } else if (c === '"') {
        break;
      } else {
        raw += c;
      }
    }
    if (line[j] !== '"') return undefined;
    labels.push([labelName, raw]);
    seen.add(labelName);
    i = j + 1;
  }
  return undefined;
}

/** The sample's line with the operator's labels stamped and the tenant's own copies removed. */
export function stampSample(
  line: string,
  stamp: Readonly<Record<string, string>>
): string | undefined {
  if (line.length > MAX_LINE_CHARS) return undefined;
  const parts = splitSample(line);
  if (!parts || isReservedName(parts.name)) return undefined;
  const kept = parts.labels
    .filter(([name]) => !OPERATOR_LABELS.has(name))
    .map(([name, raw]) => `${name}="${raw}"`);
  const stamped = Object.entries(stamp).map(
    ([name, value]) => `${name}="${escapeLabelValue(value)}"`
  );
  return `${parts.name}{${[...kept, ...stamped].join(",")}}${parts.rest}`;
}

const METRIC_TYPES: ReadonlySet<string> = new Set([
  "counter",
  "gauge",
  "histogram",
  "summary",
  "untyped",
  "unknown",
]);
const HELP_MAX = 200;

/**
 * HELP text safe to forward: control characters become spaces, a backslash is kept only as one of the two valid
 * escapes (`\\` or `\n`; any other becomes an escaped backslash), and the result is cut on a token boundary.
 */
function sanitizeHelp(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    const next = value[i + 1];
    let token: string;
    if (ch === "\\") {
      if (next === "\\" || next === "n") {
        token = `\\${next}`;
        i += 1;
      } else {
        token = "\\\\";
      }
    } else {
      const code = ch.charCodeAt(0);
      token = code < 0x20 || code === 0x7f ? " " : ch;
    }
    if (out.length + token.length > HELP_MAX) break;
    out += token;
  }
  return out;
}

interface Family {
  help?: string;
  type?: string;
  readonly lines: string[];
}

/** A merged exposition: families keep one HELP/TYPE and every lane's stamped samples grouped together. */
class Exposition {
  private readonly families = new Map<string, Family>();

  family(name: string): Family {
    let family = this.families.get(name);
    if (!family) {
      family = { lines: [] };
      this.families.set(name, family);
    }
    return family;
  }

  /** Add one lane's exposition text under the operator's labels. Returns how many samples it contributed. */
  addLane(text: string, stamp: Readonly<Record<string, string>>): number {
    let current: string | undefined;
    let added = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      if (line === "" || line.length > MAX_LINE_CHARS) continue;
      if (line.startsWith("#")) {
        const m =
          /^#\s+(HELP|TYPE)\s+([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\s+(.*))?$/.exec(
            line
          );
        if (!m) continue;
        const [, kind, name, value] = m as unknown as [
          string,
          "HELP" | "TYPE",
          string,
          string | undefined,
        ];
        if (isReservedName(name)) {
          current = undefined;
          continue;
        }
        const family = this.family(name);
        if (kind === "HELP" && family.help === undefined)
          family.help = sanitizeHelp(value ?? "");
        // Tenant metadata is validated like its samples: one bad TYPE line must not fail the whole merged scrape.
        const type = (value ?? "").trim();
        if (
          kind === "TYPE" &&
          family.type === undefined &&
          METRIC_TYPES.has(type)
        )
          family.type = type;
        current = name;
        continue;
      }
      const stamped = stampSample(line, stamp);
      if (stamped === undefined) continue;
      const sampleName = (SAMPLE_START.exec(line) as RegExpExecArray)[0];
      const key =
        current !== undefined &&
        (sampleName === current || sampleName.startsWith(`${current}_`))
          ? current
          : sampleName;
      this.family(key).lines.push(stamped);
      added += 1;
    }
    return added;
  }

  render(): string {
    const out: string[] = [];
    for (const [name, family] of this.families) {
      if (family.lines.length === 0) continue;
      if (family.help !== undefined) out.push(`# HELP ${name} ${family.help}`);
      if (family.type !== undefined) out.push(`# TYPE ${name} ${family.type}`);
      out.push(...family.lines);
    }
    return `${out.join("\n")}\n`;
  }
}

/** The labels the operator stamps on every series of one lane. */
export function laneStamp(lane: LeaseScrapeLane): Record<string, string> {
  return {
    node: lane.nodeId,
    env: lane.env,
    workload: lane.workload,
    service: "app",
  };
}

/** Merge lane outcomes into one exposition with the scrape synthetic series. */
export function renderLeaseMetrics(
  outcomes: readonly LeaseScrapeOutcome[],
  truncated: boolean
): LeaseMetricsReport {
  const exposition = new Exposition();
  const reasons: Record<string, number> = {};
  const up = exposition.family("cogni_lease_scrape_up");
  up.help =
    "1 when the operator scraped at least one sample from this lease's /api/metrics, else 0.";
  up.type = "gauge";
  const info = exposition.family("cogni_lease_scrape_info");
  info.help =
    "Why the last scrape of this lease read as it did (bounded reason enum).";
  info.type = "gauge";
  const duration = exposition.family("cogni_lease_scrape_duration_seconds");
  duration.help = "Seconds the operator spent scraping this lease.";
  duration.type = "gauge";
  const cut = exposition.family("cogni_lease_scrape_lanes_truncated");
  cut.help =
    "1 when the lane list hit its bound and some lanes were not scraped.";
  cut.type = "gauge";
  cut.lines.push(`cogni_lease_scrape_lanes_truncated ${truncated ? 1 : 0}`);

  let scraped = 0;
  for (const outcome of outcomes) {
    const stamp = laneStamp(outcome.lane);
    const labels = Object.entries({
      node: stamp.node,
      env: stamp.env,
      workload: stamp.workload,
    })
      .map(([k, v]) => `${k}="${escapeLabelValue(v as string)}"`)
      .join(",");
    let reason = outcome.reason;
    if (reason === "ok" && outcome.body !== undefined) {
      // ABSENCE_IS_VISIBLE: up is 1 only when the lane really contributed samples (a 200 HTML page is not metrics).
      if (exposition.addLane(outcome.body, stamp) > 0) scraped += 1;
      else reason = "empty";
    }
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    up.lines.push(
      `cogni_lease_scrape_up{${labels}} ${reason === "ok" ? 1 : 0}`
    );
    info.lines.push(`cogni_lease_scrape_info{${labels},reason="${reason}"} 1`);
    duration.lines.push(
      `cogni_lease_scrape_duration_seconds{${labels}} ${outcome.durationSeconds}`
    );
  }
  return {
    text: exposition.render(),
    lanes: outcomes.length,
    scraped,
    failed: outcomes.length - scraped,
    truncated,
    reasons,
  };
}

/** One bounded pass: scrape every lane and merge. Never throws. */
export async function collectLeaseMetrics(
  input: LeaseMetricsInput,
  deps: LeaseMetricsDeps
): Promise<LeaseMetricsReport> {
  const outcomes = await scrapeLeases(input, deps);
  return renderLeaseMetrics(outcomes, input.truncated);
}
