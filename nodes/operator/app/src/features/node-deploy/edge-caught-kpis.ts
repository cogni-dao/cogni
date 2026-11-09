// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/edge-caught-kpis`
 * Purpose: The operator's node-local goal-metric calculator `edge.caught@1` (story.5148, edge-availability-design
 *   rev 7.1, "Measure"): how many requests the env's edge Caddy answered with its own catch-all (a 503 that
 *   carries `X-Cogni-Edge: caught`) over a 300 s, 1 h or 24 h window, for ONE application host or for every
 *   application host the env's edge serves. A user-facing failure becomes downtime evidence even when the origin
 *   is too dead to log it. Registered through `@cogni-dao/metrics` `createGoalMetrics({ nodeCalculators })`, like
 *   the fleet calculators.
 * Scope: Pure classification and the calculator object. IO comes in through injected sources: the catalog roster
 *   (`EdgeHostCatalogPort`), one bounded public HTTP probe (`DeliveryKpiSourcePort.probe`) and the Loki reader
 *   (`LokiReaderPort` for the probe's own line, `LokiInstantReaderPort` for the count). This module does no IO itself.
 * Invariants:
 *   - CALCULATOR_IS_THE_PROBER: every compute GETs `https://<host>/-/edge-probe?probe=<nonce>` and requires 503 with
 *     `X-Cogni-Edge: caught`. The canary always raises a Caddy-made error, so this proves the catch-all is live.
 *   - PROBE_LINE_IS_THE_WRITER_PROOF: the number is reported only after THIS probe's own access-log line (found by
 *     its nonce, for the probed host) is read back from Loki. That proves Caddy, Alloy and Loki together
 *     (guard-needs-proven-writer). Lines older than the proven one are therefore ingested.
 *   - WHO_IS_PROBED: with a `host` param, that host is probed (it must be a roster host). With no `host` the count
 *     covers every roster application host, and the operator's OWN env host is probed: one Caddy serves the whole
 *     env and every site imports the same catch-all snippet, so that one proof covers the env's catch-all and log
 *     path. If it fails, the env-wide count is unknown.
 *   - COUNT_HAS_NO_LINE_CAP: the number is a Loki INSTANT metric query (`sum(count_over_time(... [<window>s]))`),
 *     so no window can truncate it. A line read (capped) is used only for the probe's own line.
 *   - UNKNOWN_NOT_ZERO: a failed canary, a missing probe line, an unwired Loki reader, a failing Loki query, an
 *     invalid vector, an unprobed host or an env this operator does not serve is an incomplete sample with a
 *     reason, never 0. Only a proven pipeline with an empty vector reads 0.
 *   - CANARY_IS_EXCLUDED: the count drops every line that mentions `/-/edge-probe` (`!= "/-/edge-probe"`). The only
 *     over-exclusion is a caught line that quotes that path elsewhere (for example in a referer).
 *   - HOSTS_FROM_THE_RENDERER_SOURCE: the roster is the catalog (`type: node` rows with a `node_port`; the primary
 *     row owns the bare env domain) joined to the operator's own env domain, exactly as
 *     `scripts/ci/render-caddyfile.sh --domain` emits application sites. Nothing names a host. The mesh control,
 *     relay and publish hosts are not in the roster: they have no canary, never count, and as a `host` param read
 *     `unprobed_host`.
 *   - OWN_ENV_ONLY: the env domain is the operator's own (`APP_BASE_URL` host), so a param `env` other than the
 *     operator's own env is unknown.
 *   - ONE_EVENT_PER_WINDOW: every compute emits exactly one `edge_caught_window` event with stable enum fields
 *     (scope, host, env, window, outcome, caught, reason), so a Grafana alert can read Loki. No error text, header
 *     or URL is logged.
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
  LokiInstantReaderPort,
  LokiLogLine,
  LokiReaderPort,
  LokiVectorSample,
} from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

export const EDGE_CAUGHT_ID = "edge.caught@1";
/** The path each application site always answers with a Caddy-made 502 (rewritten to the catch-all 503). */
export const EDGE_CANARY_PATH = "/-/edge-probe";
/** The windows a metric definition may ask for: 5 minutes, 1 hour, 1 day. */
export const EDGE_WINDOWS_SECONDS = [300, 3600, 86400] as const;
export const DEFAULT_EDGE_WINDOW_SECONDS = 300;
/** Most lines the probe-line read returns (one probe makes one line). */
export const MAX_PROBE_LINES = 20;
export const CANARY_PROBE_TIMEOUT_MS = 5_000;
const CANARY_MAX_BYTES = 4096;
/** Waits before each read of the probe's own line: Alloy and Loki ingest within seconds. */
export const PROBE_LINE_POLL_DELAYS_MS: readonly number[] = [4, 6, 8].map(
  (seconds) => seconds * 1000
);
/** The probe line is looked up from this long before the probe was sent. */
const PROBE_LOOKBACK_MS = 5_000;
const UNIT = "responses";

const envSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** A lowercase DNS name with a non-numeric last label (no IP literals); safe to embed in a LogQL string. */
export const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]([a-z0-9-]*[a-z0-9])?$/;
const hostSchema = z.string().max(253).regex(HOST_RE);
const windowSecondsSchema = z
  .union([z.literal(300), z.literal(3600), z.literal(86400)])
  .default(DEFAULT_EDGE_WINDOW_SECONDS);

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

/**
 * The total of an instant-query vector. An empty vector is 0 (nothing matched). A sample that is not a finite,
 * non-negative number makes the vector invalid: undefined, never a guess.
 */
export function vectorTotal(
  vector: readonly LokiVectorSample[]
): number | undefined {
  let total = 0;
  for (const s of vector) {
    if (!Number.isFinite(s.value) || s.value < 0) return undefined;
    total += s.value;
  }
  return Math.round(total);
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
  | "count_invalid"
  | "source_error"
  | "aborted";

export type EdgeWindowOutcome =
  | { readonly kind: "number"; readonly caught: number }
  | {
      readonly kind: "unknown";
      readonly reason: EdgeUnknownReason;
      readonly canaryStatus?: number;
    };

/**
 * The reading of one scope and window. A number needs a proven canary AND its proven log line AND a valid count
 * vector (empty = 0); anything less is unknown. Pure: the calculator gathers the facts, this decides.
 */
export function decideWindow(input: {
  readonly canary: CanaryVerdict;
  readonly probeLineSeen: boolean;
  readonly vector: readonly LokiVectorSample[];
}): EdgeWindowOutcome {
  const { canary, probeLineSeen, vector } = input;
  if (!canary.ok)
    return {
      kind: "unknown",
      reason: canary.reason,
      ...(canary.status === undefined ? {} : { canaryStatus: canary.status }),
    };
  if (!probeLineSeen) return { kind: "unknown", reason: "canary_log_missing" };
  const total = vectorTotal(vector);
  if (total === undefined) return { kind: "unknown", reason: "count_invalid" };
  return { kind: "number", caught: total };
}

const KPI_REASON: Record<
  EdgeUnknownReason,
  NonNullable<MetricSample["reason"]>
> = {
  env_not_served: "incomplete_or_invalid_source",
  unprobed_host: "incomplete_or_invalid_source",
  count_invalid: "incomplete_or_invalid_source",
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
const NOT_CANARY = `!= "${EDGE_CANARY_PATH}"`;
const escapeRegex = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/**
 * Case-insensitive match of a logged `"host":"<host>"`, with an optional port (a logged host may be
 * `Host.example.org:443`). Several hosts become one alternation. `parseCaddyLine` is exact; this is the pre-filter.
 */
export function hostLineFilter(hosts: readonly string[]): string {
  const names = hosts.map(escapeRegex);
  const alt = names.length === 1 ? names[0] : `(${names.join("|")})`;
  return `|~ \`(?i)"host":"${alt}(:[0-9]+)?"\``;
}

/** The line of one probe: caught lines of the host whose uri carries the probe nonce. */
export function probeLineQuery(
  env: string,
  host: string,
  nonce: string
): string {
  return `{service="caddy", env="${env}"} ${CAUGHT_MARKER} ${hostLineFilter([host])} |= "probe=${nonce}"`;
}

/**
 * The count: caught lines of `hosts` in one env over `windowSeconds`, canary excluded, as one instant metric
 * query (no line cap at any window).
 */
export function caughtCountQuery(
  env: string,
  hosts: readonly string[],
  windowSeconds: number
): string {
  return `sum(count_over_time({service="caddy", env="${env}"} ${CAUGHT_MARKER} ${NOT_CANARY} ${hostLineFilter(hosts)} [${windowSeconds}s]))`;
}

const nanos = (ms: number) => `${Math.trunc(ms)}000000`;

// ---------------------------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------------------------

/** The one structured event per compute. Enums, counts and the public host only. */
export interface EdgeCaughtWindowEvent {
  /** The registry name as a field (hub contract): Grafana filters on `event`, not only the message. */
  readonly event: typeof EVENT_NAMES.EDGE_CAUGHT_WINDOW;
  readonly env: string;
  /** `host`: one application host. `env`: every application host of the env. */
  readonly scope: "host" | "env";
  /** The host counted (scope `host`) or probed (scope `env`: the operator's own env host); null when never resolved. */
  readonly host: string | null;
  readonly windowSeconds: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly outcome: "number" | "unknown";
  /** The caught count, or null when unknown. */
  readonly caught: number | null;
  /** `none` for a number; the stable unknown reason otherwise. */
  readonly reason: EdgeUnknownReason | "none";
  readonly canaryStatus: number | null;
  readonly durationMs: number;
}

export interface EdgeCaughtOptions {
  /** The operator's own env (`DEPLOY_ENVIRONMENT`) and its env domain (the `APP_BASE_URL` host). */
  readonly env: string | undefined;
  readonly domain: string | undefined;
  readonly catalog: EdgeHostCatalogPort;
  readonly probe: DeliveryKpiSourcePort["probe"];
  /** Null when the Grafana read credential is unwired: every reading is unknown. */
  readonly loki: (LokiReaderPort & LokiInstantReaderPort) | null;
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

  const params = z.strictObject({
    env: envSchema,
    // Omitted = every application host of the env (probed through the operator's own env host).
    host: hostSchema.optional(),
    windowSeconds: windowSecondsSchema,
  });

  const caught: MetricCalculator = {
    id: EDGE_CAUGHT_ID,
    unit: UNIT,
    display: "volume",
    windowSeconds: (raw) => params.parse(raw).windowSeconds,
    paramsSchema: params,
    budget: {
      // probe (5 s) + three polls (18 s of waits) + the count query, with room for slow reads.
      timeoutMs: 60_000,
      // roster + probe + up to three probe-line reads + the count query.
      maxSourceCalls: 7,
      maxRows: MAX_PROBE_LINES,
      maxResponseBytes: CANARY_MAX_BYTES,
    },
    async compute(rawParams, ctx) {
      const p = params.parse(rawParams);
      const scope = p.host === undefined ? "env" : "host";
      const startedMs = now();
      let probeAtMs = startedMs;
      // The host probed: the asked host, or the operator's own env host for an env-wide count.
      const probeHost = p.host ?? options.domain ?? null;

      const finish = (outcome: EdgeWindowOutcome): MetricSample => {
        const endedMs = now();
        options.log({
          event: EVENT_NAMES.EDGE_CAUGHT_WINDOW,
          env: p.env,
          scope,
          host: probeHost,
          windowSeconds: p.windowSeconds,
          windowStart: ctx.window.start,
          windowEnd: ctx.window.end,
          outcome: outcome.kind,
          caught: outcome.kind === "number" ? outcome.caught : null,
          reason: outcome.kind === "number" ? "none" : outcome.reason,
          canaryStatus:
            outcome.kind === "unknown" ? (outcome.canaryStatus ?? null) : null,
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
        const head = [
          `edge:env=${p.env}`,
          `edge:scope=${scope}`,
          ...(probeHost ? [`edge:host=${probeHost}`] : []),
          `edge:window_s=${p.windowSeconds}`,
        ];
        if (outcome.kind === "number")
          return {
            value: outcome.caught,
            unit: UNIT,
            complete: true,
            sourceWatermarks,
            evidenceRefs: [
              ...head,
              `edge:caught=${outcome.caught}`,
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
        const hosts = edgeApplicationHosts(options.domain, nodes);
        // A host outside the roster (a mesh host) has no canary; an env with no roster host has nothing to probe.
        if (probeHost === null || !hosts.includes(probeHost))
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
              host: probeHost,
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
            decideWindow({ canary, probeLineSeen: false, vector: [] })
          );

        // 2. The probe's own line must be readable in Loki for the probed host, or the log path is not proven.
        let probeLineSeen = false;
        for (const delay of PROBE_LINE_POLL_DELAYS_MS) {
          await sleep(delay, ctx.signal);
          const lines = await ctx.read((signal) =>
            loki.queryRange({
              query: probeLineQuery(p.env, probeHost, id),
              startNs: nanos(sentMs - PROBE_LOOKBACK_MS),
              endNs: nanos(now() + PROBE_LOOKBACK_MS),
              limit: MAX_PROBE_LINES,
              signal,
            })
          );
          if (hasProbeLine(lines, probeHost, id)) {
            probeLineSeen = true;
            break;
          }
        }
        if (!probeLineSeen)
          return finish(decideWindow({ canary, probeLineSeen, vector: [] }));

        // 3. The count: one instant metric query over the window, canary excluded, no line cap.
        const vector = await ctx.read((signal) =>
          loki.queryInstant({
            query: caughtCountQuery(
              p.env,
              p.host === undefined ? hosts : [p.host],
              p.windowSeconds
            ),
            atNs: nanos(Date.parse(ctx.window.end)),
            signal,
          })
        );
        return finish(decideWindow({ canary, probeLineSeen, vector }));
      } catch (error) {
        // A caller abort (budget timeout) is not a reading: the engine records it. Log it once, then rethrow.
        if (ctx.signal.aborted) {
          finish({ kind: "unknown", reason: "aborted" });
          throw error;
        }
        // The source-call budget error and any source failure (a Loki query error): unknown, stable reason.
        return finish({ kind: "unknown", reason: "source_error" });
      }
    },
  };

  return [caught];
}
