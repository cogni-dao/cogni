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
/** Largest accepted body per lane. A body at the cap counts as too large. */
export const LEASE_SCRAPE_MAX_BYTES = 2_000_000;

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
  | "too_large";

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

function classify(result: LeaseFetchResult): LeaseScrapeReason {
  if (result.kind === "unreachable") {
    return result.code === "timeout" ||
      result.code === "network" ||
      result.code === "invalid_target"
      ? result.code
      : "network";
  }
  if (result.status === 200) {
    return result.body.length >= LEASE_SCRAPE_MAX_BYTES ? "too_large" : "ok";
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
]);
const SYNTHETIC_PREFIX = "cogni_lease_scrape_";
const SAMPLE_START = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
/** ` <value>[ <timestamp>]` after the labels: a float, `NaN` or `+Inf`/`-Inf`, then an optional integer. */
const SAMPLE_VALUE =
  /^\s+(?:[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|Inf)|NaN)(?:\s+-?\d+)?\s*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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
    const rest = line.slice(i);
    return SAMPLE_VALUE.test(rest) ? { name, labels: [], rest } : undefined;
  }
  i += 1;
  const labels: (readonly [string, string])[] = [];
  while (i < line.length) {
    while (line[i] === " " || line[i] === ",") i += 1;
    if (line[i] === "}") {
      const rest = line.slice(i + 1);
      return SAMPLE_VALUE.test(rest) ? { name, labels, rest } : undefined;
    }
    const eq = line.indexOf("=", i);
    if (eq < 0) return undefined;
    const labelName = line.slice(i, eq).trim();
    if (!LABEL_NAME.test(labelName) || line[eq + 1] !== '"') return undefined;
    let j = eq + 2;
    let raw = "";
    for (; j < line.length; j += 1) {
      const c = line[j];
      if (c === "\\") {
        raw += `${c}${line[j + 1] ?? ""}`;
        j += 1;
      } else if (c === '"') {
        break;
      } else {
        raw += c;
      }
    }
    if (line[j] !== '"') return undefined;
    labels.push([labelName, raw]);
    i = j + 1;
  }
  return undefined;
}

/** The sample's line with the operator's labels stamped and the tenant's own copies removed. */
export function stampSample(
  line: string,
  stamp: Readonly<Record<string, string>>
): string | undefined {
  const parts = splitSample(line);
  if (!parts || parts.name.startsWith(SYNTHETIC_PREFIX)) return undefined;
  const kept = parts.labels
    .filter(([name]) => !OPERATOR_LABELS.has(name))
    .map(([name, raw]) => `${name}="${raw}"`);
  const stamped = Object.entries(stamp).map(
    ([name, value]) => `${name}="${escapeLabelValue(value)}"`
  );
  return `${parts.name}{${[...kept, ...stamped].join(",")}}${parts.rest}`;
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

  /** Add one lane's exposition text under the operator's labels. */
  addLane(text: string, stamp: Readonly<Record<string, string>>): void {
    let current: string | undefined;
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      if (line === "") continue;
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
        if (name.startsWith(SYNTHETIC_PREFIX)) {
          current = undefined;
          continue;
        }
        const family = this.family(name);
        if (kind === "HELP" && family.help === undefined)
          family.help = value ?? "";
        if (kind === "TYPE" && family.type === undefined)
          family.type = value ?? "untyped";
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
    }
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
    "Whether the operator scraped this lease's /api/metrics (1) or not (0), with the bounded reason.";
  up.type = "gauge";
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
    const ok = outcome.reason === "ok";
    reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1;
    up.lines.push(
      `cogni_lease_scrape_up{${labels},reason="${outcome.reason}"} ${ok ? 1 : 0}`
    );
    duration.lines.push(
      `cogni_lease_scrape_duration_seconds{${labels}} ${outcome.durationSeconds}`
    );
    if (ok && outcome.body !== undefined) {
      exposition.addLane(outcome.body, stamp);
      scraped += 1;
    }
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
