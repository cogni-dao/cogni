// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/edge-caught-kpis`
 * Purpose: The operator's node-local goal-metric calculator `edge.caught@1` (story.5148, edge-availability-design
 *   rev 7.1, "Measure"): how many requests the env's edge Caddy answered with its own catch-all (a 503 that
 *   carries `X-Cogni-Edge: caught`) for ONE application host in the last 300 s. A user-facing failure becomes
 *   downtime evidence even when the origin is too dead to log it. Registered through `@cogni-dao/metrics`
 *   `createGoalMetrics({ nodeCalculators })`, like the fleet calculators.
 * Scope: Pure classification and the calculator object. IO comes in through injected sources: the catalog roster
 *   (`EdgeHostCatalogPort`), one bounded public HTTP probe (`DeliveryKpiSourcePort.probe`) and the Loki reader
 *   (`LokiReaderPort`). This module does no IO itself.
 * Invariants:
 *   - CALCULATOR_IS_THE_PROBER: every compute GETs `https://<host>/__edge/caught?probe=<nonce>` and requires 503 with
 *     `X-Cogni-Edge: caught`. The canary always raises a Caddy-made error, so this proves the catch-all is live.
 *   - PROBE_LINE_IS_THE_WRITER_PROOF: the number is reported only after THIS probe's own access-log line (found by
 *     its nonce, for this host) is read back from Loki. That proves Caddy, Alloy and Loki together
 *     (guard-needs-proven-writer). Lines older than the proven one are therefore ingested.
 *   - UNKNOWN_NOT_ZERO: a failed canary, a missing probe line, an unwired or failing Loki read, a truncated or
 *     unparseable read, an unprobed host or an env this operator does not serve is an incomplete sample with a
 *     reason, never 0. Only a proven pipeline with no caught line reads 0.
 *   - CANARY_IS_EXCLUDED: lines whose path is `/__edge/caught` (any query) never count; they are reported as
 *     `edge:canary_excluded=`.
 *   - HOSTS_FROM_THE_RENDERER_SOURCE: the probed hosts are the catalog roster (`type: node` rows with a
 *     `node_port`; the primary row owns the bare env domain) joined to the operator's own env domain, exactly as
 *     `scripts/ci/render-caddyfile.sh --domain` emits application sites. Nothing names a host. A host outside
 *     that list (the mesh control, relay and publish hosts, which have no canary) is `unprobed`: unknown.
 *   - OWN_ENV_ONLY: the env domain is the operator's own (`APP_BASE_URL` host), so a param `env` other than the
 *     operator's own env is unknown.
 *   - ONE_EVENT_PER_WINDOW: every compute emits exactly one `edge_caught_window` event with stable enum fields
 *     (host, env, outcome, caught, reason), so a Grafana alert can read Loki. No error text, header or URL is logged.
 *   - IDS_USE_DASHES: the calculator id matches `MetricSpecSchema.calculatorId` (no underscores).
 * Side-effects: none (calculators call the injected sources)
 * Links: ports/edge-host-catalog.port.ts, ports/loki-reader.port.ts, ports/delivery-kpi.port.ts,
 *   bootstrap/capabilities/goal-metrics.ts, scripts/ci/render-caddyfile.sh, infra/compose/edge/configs/catch-all.caddy,
 *   story.5148
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type {
  DeliveryKpiSourcePort,
  DeliveryProbeResult,
  EdgeCatalogNode,
  EdgeHostCatalogPort,
  LokiLogLine,
  LokiReaderPort,
} from "@/ports";

export const EDGE_CAUGHT_ID = "edge.caught@1";
/** The path each application site always answers with a Caddy-made 502 (rewritten to the catch-all 503). */
export const EDGE_CANARY_PATH = "/__edge/caught";
/** The measured interval is the 300 s refresh cadence. */
export const EDGE_WINDOW_SECONDS = 300;
/** Most caught lines one window read returns; a read that fills it is unknown, not a capped number. */
export const MAX_CAUGHT_LINES = 5000;
/** Most lines the probe-line read returns (one probe makes one line). */
export const MAX_PROBE_LINES = 20;
export const CANARY_PROBE_TIMEOUT_MS = 5000;
const CANARY_MAX_BYTES = 4096;
/** Waits before each read of the probe's own line: Alloy and Loki ingest within seconds. */
export const PROBE_LINE_POLL_DELAYS_MS: readonly number[] = [4000, 6000, 8000];
/** The probe line is looked up from this long before the probe was sent. */
const PROBE_LOOKBACK_MS = 5000;
const UNIT = "responses";

const envSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** A lowercase DNS name with a non-numeric last label (no IP literals); safe to embed in a LogQL string. */
export const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]([a-z0-9-]*[a-z0-9])?$/;
const hostSchema = z.string().max(253).regex(HOST_RE);

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

/**
 * The application hosts the edge Caddy serves for an env whose operator domain is `domain`, as
 * `render-caddyfile.sh` derives them (`host_for_node`): the primary row owns the bare domain; any other node is
 * `<slug>-<domain>` under a deep domain (3+ labels, e.g. `test.cognidao.org`) and `<slug>.<domain>` under a
 * short one. `www.<domain>` is a redirect, not an application, so it is not here.
 */
export function edgeApplicationHosts(
  domain: string,
  nodes: readonly EdgeCatalogNode[]
): string[] {
  const deep = domain.split(".").length >= 3;
  const hosts = nodes.map((n) =>
    n.primary ? domain : deep ? `${n.slug}-${domain}` : `${n.slug}.${domain}`
  );
  return [...new Set(hosts.map((h) => h.toLowerCase()))].sort();
}

export type CanaryVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "canary_unreachable"
        | "canary_status"
        | "canary_no_edge_header";
      readonly status?: number;
    };

/** The canary is proven only by a 503 that carries `X-Cogni-Edge: caught`. */
export function classifyCanaryProbe(
  result: DeliveryProbeResult
): CanaryVerdict {
  if (result.kind === "unreachable")
    return { ok: false, reason: "canary_unreachable" };
  if (result.status !== 503)
    return { ok: false, reason: "canary_status", status: result.status };
  const marker = Object.entries(result.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "x-cogni-edge"
  )?.[1];
  return marker?.trim().toLowerCase() === "caught"
    ? { ok: true }
    : { ok: false, reason: "canary_no_edge_header", status: 503 };
}

export interface CaddyLogLine {
  readonly host: string;
  readonly uri: string;
  readonly status: number;
  /** The response carried `X-Cogni-Edge: caught`. */
  readonly caught: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse one Caddy JSON access-log line; undefined when it is not one (missing host, uri or status). */
export function parseCaddyLine(line: string): CaddyLogLine | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(doc) || !isRecord(doc.request)) return undefined;
  const { host, uri } = doc.request;
  if (
    typeof host !== "string" ||
    typeof uri !== "string" ||
    typeof doc.status !== "number"
  )
    return undefined;
  const headers = isRecord(doc.resp_headers) ? doc.resp_headers : {};
  const marker = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "x-cogni-edge"
  )?.[1];
  const values = Array.isArray(marker) ? marker : [];
  return {
    // A Host header may carry a port; the roster is bare names.
    host: host.toLowerCase().replace(/:\d+$/, ""),
    uri,
    status: doc.status,
    caught: values.some(
      (v) => typeof v === "string" && v.toLowerCase() === "caught"
    ),
  };
}

/** The canary path, with any query string. Never a real user failure, so it never counts. */
export function isCanaryUri(uri: string): boolean {
  const path = uri.split("?")[0]?.toLowerCase();
  return path === EDGE_CANARY_PATH;
}

export interface CaughtCount {
  /** Caught lines for the host, canary excluded. */
  readonly caught: number;
  /** Caught canary lines for the host (excluded from `caught`). */
  readonly canaryExcluded: number;
  /** Lines that were not parseable Caddy access lines: the count cannot be trusted. */
  readonly unparseable: number;
}

/** Count caught lines for `host` over Loki lines, excluding the canary path. Other hosts' lines are ignored. */
export function countCaught(
  lines: readonly LokiLogLine[],
  host: string
): CaughtCount {
  let caught = 0;
  let canaryExcluded = 0;
  let unparseable = 0;
  for (const { line } of lines) {
    const parsed = parseCaddyLine(line);
    if (!parsed) {
      unparseable++;
      continue;
    }
    if (parsed.host !== host || !parsed.caught) continue;
    if (isCanaryUri(parsed.uri)) canaryExcluded++;
    else caught++;
  }
  return { caught, canaryExcluded, unparseable };
}

/** Whether one of `lines` is the line of the probe with this nonce, on this host: a caught 503 for the canary. */
export function hasProbeLine(
  lines: readonly LokiLogLine[],
  host: string,
  nonce: string
): boolean {
  return lines.some(({ line }) => {
    const p = parseCaddyLine(line);
    return (
      p !== undefined &&
      p.host === host &&
      p.caught &&
      p.status === 503 &&
      isCanaryUri(p.uri) &&
      p.uri.includes(`probe=${nonce}`)
    );
  });
}

/** Why a window reads unknown. A stable enum: it is logged and never carries error text. */
export type EdgeUnknownReason =
  | "env_not_served"
  | "unprobed_host"
  | "loki_unwired"
  | "canary_unreachable"
  | "canary_status"
  | "canary_no_edge_header"
  | "canary_log_missing"
  | "log_read_truncated"
  | "log_lines_unparseable"
  | "source_error"
  | "aborted";

export type EdgeWindowOutcome =
  | {
      readonly kind: "number";
      readonly caught: number;
      readonly canaryExcluded: number;
    }
  | {
      readonly kind: "unknown";
      readonly reason: EdgeUnknownReason;
      readonly canaryStatus?: number;
    };

/**
 * The reading of one host and window. A number needs a proven canary AND its proven log line AND a complete,
 * parseable window read; anything less is unknown. Pure: the calculator gathers the facts, this decides.
 */
export function decideWindow(input: {
  readonly canary: CanaryVerdict;
  readonly probeLineSeen: boolean;
  readonly window: CaughtCount & { readonly lineCount: number };
  readonly maxLines: number;
}): EdgeWindowOutcome {
  const { canary, probeLineSeen, window, maxLines } = input;
  if (!canary.ok)
    return {
      kind: "unknown",
      reason: canary.reason,
      ...(canary.status === undefined ? {} : { canaryStatus: canary.status }),
    };
  if (!probeLineSeen) return { kind: "unknown", reason: "canary_log_missing" };
  if (window.lineCount >= maxLines)
    return { kind: "unknown", reason: "log_read_truncated" };
  if (window.unparseable > 0)
    return { kind: "unknown", reason: "log_lines_unparseable" };
  return {
    kind: "number",
    caught: window.caught,
    canaryExcluded: window.canaryExcluded,
  };
}

const KPI_REASON: Record<
  EdgeUnknownReason,
  NonNullable<MetricSample["reason"]>
> = {
  env_not_served: "incomplete_or_invalid_source",
  unprobed_host: "incomplete_or_invalid_source",
  log_read_truncated: "incomplete_or_invalid_source",
  log_lines_unparseable: "incomplete_or_invalid_source",
  loki_unwired: "source_failed",
  canary_unreachable: "source_failed",
  canary_status: "source_failed",
  canary_no_edge_header: "source_failed",
  canary_log_missing: "source_failed",
  source_error: "source_failed",
  aborted: "source_timeout",
};

// ---------------------------------------------------------------------------------------------
// Loki queries
// ---------------------------------------------------------------------------------------------

const CAUGHT_MARKER = '|= "\\"X-Cogni-Edge\\":[\\"caught\\"]"';

/** Caught lines of one host in one env (the canary included; it is excluded when counting). */
export function caughtQuery(env: string, host: string): string {
  return `{service="caddy", env="${env}"} ${CAUGHT_MARKER} |= "\\"host\\":\\"${host}\\""`;
}

/** The line of one probe: caught lines of the host whose uri carries the probe nonce. */
export function probeLineQuery(
  env: string,
  host: string,
  nonce: string
): string {
  return `${caughtQuery(env, host)} |= "probe=${nonce}"`;
}

const nanos = (ms: number) => `${Math.trunc(ms)}000000`;

// ---------------------------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------------------------

/** The one structured event per window. Enums, counts and the public host only. */
export interface EdgeCaughtWindowEvent {
  readonly env: string;
  readonly host: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly outcome: "number" | "unknown";
  /** The caught count, or null when unknown. */
  readonly caught: number | null;
  /** `none` for a number; the stable unknown reason otherwise. */
  readonly reason: EdgeUnknownReason | "none";
  readonly canaryStatus: number | null;
  readonly canaryExcluded: number | null;
  readonly durationMs: number;
}

export interface EdgeCaughtOptions {
  /** The operator's own env (`DEPLOY_ENVIRONMENT`) and its env domain (the `APP_BASE_URL` host). */
  readonly env: string | undefined;
  readonly domain: string | undefined;
  readonly catalog: EdgeHostCatalogPort;
  readonly probe: DeliveryKpiSourcePort["probe"];
  /** Null when the Grafana read credential is unwired: every reading is unknown. */
  readonly loki: LokiReaderPort | null;
  /** One call per compute. Bootstrap writes it to the `edge_caught_window` event. */
  readonly log: (event: EdgeCaughtWindowEvent) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly nonce?: () => string;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const defaultNonce = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function createEdgeCaughtCalculators(
  options: EdgeCaughtOptions
): MetricCalculator[] {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const nonce = options.nonce ?? defaultNonce;

  const params = z.strictObject({ env: envSchema, host: hostSchema });

  const caught: MetricCalculator = {
    id: EDGE_CAUGHT_ID,
    unit: UNIT,
    display: "volume",
    windowSeconds: () => EDGE_WINDOW_SECONDS,
    paramsSchema: params,
    budget: {
      // probe (5 s) + three polls (18 s of waits) + the window read, with room for slow reads.
      timeoutMs: 45_000,
      // roster + probe + up to three probe-line reads + the window read.
      maxSourceCalls: 7,
      maxRows: MAX_CAUGHT_LINES,
      maxResponseBytes: CANARY_MAX_BYTES,
    },
    async compute(rawParams, ctx) {
      const p = params.parse(rawParams);
      const startedMs = now();
      let probeAtMs = startedMs;
      let canaryExcluded: number | undefined;

      const finish = (outcome: EdgeWindowOutcome): MetricSample => {
        const endedMs = now();
        options.log({
          env: p.env,
          host: p.host,
          windowStart: ctx.window.start,
          windowEnd: ctx.window.end,
          outcome: outcome.kind,
          caught: outcome.kind === "number" ? outcome.caught : null,
          reason: outcome.kind === "number" ? "none" : outcome.reason,
          canaryStatus:
            outcome.kind === "unknown" ? (outcome.canaryStatus ?? null) : null,
          canaryExcluded:
            outcome.kind === "number"
              ? outcome.canaryExcluded
              : (canaryExcluded ?? null),
          durationMs: endedMs - startedMs,
        });
        const sourceWatermarks = [
          {
            source: "edge_canary_probe",
            asOf: new Date(Math.min(probeAtMs, endedMs)).toISOString(),
          },
          {
            source: "loki_caddy_access_log",
            asOf: new Date(endedMs).toISOString(),
          },
        ];
        const head = [`edge:env=${p.env}`, `edge:host=${p.host}`];
        if (outcome.kind === "number")
          return {
            value: outcome.caught,
            unit: UNIT,
            complete: true,
            sourceWatermarks,
            evidenceRefs: [
              ...head,
              `edge:caught=${outcome.caught},canary_excluded=${outcome.canaryExcluded}`,
              "edge:canary=ok,probe_line=seen",
            ],
          };
        return {
          value: 0,
          unit: UNIT,
          complete: false,
          reason: KPI_REASON[outcome.reason],
          sourceWatermarks,
          evidenceRefs: [
            ...head,
            `edge:unknown=${outcome.reason}`,
            ...(outcome.canaryStatus === undefined
              ? []
              : [`edge:canary_status=${outcome.canaryStatus}`]),
          ],
        };
      };

      try {
        if (!options.domain || !options.env || p.env !== options.env)
          return finish({ kind: "unknown", reason: "env_not_served" });
        const nodes = await ctx.read(() => options.catalog.edgeNodes());
        if (!edgeApplicationHosts(options.domain, nodes).includes(p.host))
          return finish({ kind: "unknown", reason: "unprobed_host" });
        const loki = options.loki;
        if (!loki) return finish({ kind: "unknown", reason: "loki_unwired" });

        // 1. The canary: the catch-all must answer its own path.
        const id = nonce();
        const sentMs = now();
        probeAtMs = sentMs;
        const result = await ctx.read(async (signal, budget) => {
          try {
            return await options.probe({
              host: p.host,
              path: `${EDGE_CANARY_PATH}?probe=${id}`,
              timeoutMs: CANARY_PROBE_TIMEOUT_MS,
              maxBytes: budget.maxResponseBytes,
              signal,
            });
          } catch (error) {
            // A caller abort still throws; any other probe error is this host's answer.
            if (signal.aborted) throw error;
            return { kind: "unreachable", code: "network" } as const;
          }
        });
        const canary = classifyCanaryProbe(result);
        if (!canary.ok)
          return finish(
            decideWindow({
              canary,
              probeLineSeen: false,
              window: {
                caught: 0,
                canaryExcluded: 0,
                unparseable: 0,
                lineCount: 0,
              },
              maxLines: MAX_CAUGHT_LINES,
            })
          );

        // 2. The probe's own line must be readable in Loki for this host, or the log path is not proven.
        let probeLineSeen = false;
        for (const delay of PROBE_LINE_POLL_DELAYS_MS) {
          await sleep(delay, ctx.signal);
          const lines = await ctx.read((signal) =>
            loki.queryRange({
              query: probeLineQuery(p.env, p.host, id),
              startNs: nanos(sentMs - PROBE_LOOKBACK_MS),
              endNs: nanos(now() + PROBE_LOOKBACK_MS),
              limit: MAX_PROBE_LINES,
              signal,
            })
          );
          if (hasProbeLine(lines, p.host, id)) {
            probeLineSeen = true;
            break;
          }
        }
        if (!probeLineSeen)
          return finish(
            decideWindow({
              canary,
              probeLineSeen,
              window: {
                caught: 0,
                canaryExcluded: 0,
                unparseable: 0,
                lineCount: 0,
              },
              maxLines: MAX_CAUGHT_LINES,
            })
          );

        // 3. The window's caught lines for this host, canary excluded.
        const lines = await ctx.read((signal, budget) =>
          loki.queryRange({
            query: caughtQuery(p.env, p.host),
            startNs: nanos(Date.parse(ctx.window.start)),
            endNs: nanos(Date.parse(ctx.window.end)),
            limit: budget.maxRows,
            signal,
          })
        );
        const count = countCaught(lines, p.host);
        canaryExcluded = count.canaryExcluded;
        return finish(
          decideWindow({
            canary,
            probeLineSeen,
            window: { ...count, lineCount: lines.length },
            maxLines: MAX_CAUGHT_LINES,
          })
        );
      } catch (error) {
        // A caller abort (budget timeout) is not a reading: the engine records it. Log it once, then rethrow.
        if (ctx.signal.aborted) {
          finish({ kind: "unknown", reason: "aborted" });
          throw error;
        }
        // The source-call budget error and any source failure: an unknown reading with a stable reason.
        return finish({ kind: "unknown", reason: "source_error" });
      }
    },
  };

  return [caught];
}
