// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/delivery-kpi-source.adapter`
 * Purpose: The delivery goal-KPI source (task.5442): bounded read-only SQL over the node-deploy release
 *   store (`node_workload_releases|desired|attempts`) and one bounded public HTTPS GET per probe.
 * Scope: IO only. Classification and the calculators live in `features/node-deploy/delivery-kpis.ts`.
 *   Goal metrics, not telemetry: nothing here touches Prometheus (hub goal-metrics-vs-telemetry).
 * Invariants:
 *   - READ_ONLY: SELECT only; never writes the release store.
 *   - BOUNDED: every query is `LIMIT maxRows + 1` (the extra row reports `truncated`) and is cancelled when
 *     the caller's signal aborts; every probe has its own timeout and a body cap.
 *   - UNREACHABLE_VS_CANNOT_RUN: a probe that got no HTTP answer returns `unreachable`; a caller abort is
 *     rethrown so the reading becomes unknown, never a pass.
 *   - NO_REDIRECTS: a 3xx is the lane's answer, not a hop to follow.
 *   - FIRST_TRY_FACTS: per release, one lateral aggregate over its attempts returns the first activated
 *     attempt number and whether an earlier attempt failed (bug.5617). Still one bounded query.
 *   - DURABLE_PARK: a release's park instant is the write-once `attempts.parked_at` (else the write-once
 *     admission refusal); the repeating `release_parked` step only sets `parkStepSeen`.
 *   - NOT_PUBLIC_READ: unlike `ProbePort.publicRead` (deploy proof: resolves a NEW host at the zone's
 *     authoritative nameservers), this probe asks the normal resolver, as a real visitor does. Requests
 *     send `cache-control: no-cache`; callers add a `cb=` query to `/version`.
 * Side-effects: IO (Postgres reads, outbound HTTPS)
 * Links: ports/delivery-kpi.port.ts, shared/db/node-workloads.ts, task.5442
 * @internal
 */

import type { PendingQuery, Row, Sql } from "postgres";
import type {
  DeliveryKpiSourcePort,
  DeliveryLaneFacts,
  DeliveryProbeResult,
  DeliveryReleaseFacts,
  DeliveryScope,
} from "@/ports";

/**
 * Run a query, cancelling it on abort (postgres.js has no signal option). The client is the one drizzle
 * built, whose date serializers/parsers are pass-through: send instants as ISO text with a cast, and
 * read timestamps back through `new Date(...)`.
 */
export async function cancellable<T extends readonly Row[]>(
  query: PendingQuery<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  const abort = () => {
    void query.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await query;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

const date = (v: unknown): Date | undefined =>
  v === null || v === undefined ? undefined : new Date(v as string | Date);

/** A lowercase DNS name with a non-numeric last label (no IP literals). */
const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]([a-z0-9-]*[a-z0-9])?$/;

export class DeliveryKpiSource implements DeliveryKpiSourcePort {
  constructor(
    private readonly sql: Sql,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** `AND <alias>.node_id = … AND <alias>.env = …` for the set scope fields only. */
  private scopeSql(alias: "r" | "d", scope: DeliveryScope) {
    const s = this.sql;
    const node = scope.nodeId
      ? alias === "r"
        ? s`AND r.node_id = ${scope.nodeId}`
        : s`AND d.node_id = ${scope.nodeId}`
      : s``;
    const env = scope.env
      ? alias === "r"
        ? s`AND r.env = ${scope.env}`
        : s`AND d.env = ${scope.env}`
      : s``;
    return s`${node} ${env}`;
  }

  async releases(input: {
    readonly recordedFrom: Date;
    readonly to: Date;
    readonly scope: DeliveryScope;
    readonly maxRows: number;
    readonly signal: AbortSignal;
  }) {
    const s = this.sql;
    const rows = await cancellable(
      s`
        SELECT r.id, r.node_id, r.env, r.workload, r.created_at,
          r.source_sha, r.created_by,
          r.spec -> '_admissionRefusal' ->> 'reason' AS admission_refusal_reason,
          (d.release_id = r.id) AS current,
          ag.activated_at,
          ag.activated_step_at,
          ag.first_activated_attempt,
          coalesce(ag.failed_before_activation, false) AS failed_before_activation,
          coalesce(
            ag.parked_at,
            (r.spec -> '_admissionRefusal' ->> 'at')::timestamptz
          ) AS parked_at,
          coalesce(ag.park_step_seen, false) AS park_step_seen,
          coalesce(ag.served, false) AS served
        FROM node_workload_releases r
        LEFT JOIN node_workload_desired d
          ON d.node_id = r.node_id AND d.env = r.env AND d.workload = r.workload
        LEFT JOIN LATERAL (
          -- One row per release over its attempts. x.fa is the first activated attempt, so a failure is
          -- "before activation" only for an earlier attempt (or any attempt when none ever activated).
          SELECT
            min(x.activated_at) AS activated_at,
            min(x.step_at) AS activated_step_at,
            min(x.fa) AS first_activated_attempt,
            min(x.parked_at) AS parked_at,
            bool_or(x.park_step) AS park_step_seen,
            bool_or(x.phase IN ('active', 'retiring', 'retired')) AS served,
            bool_or(x.failed) FILTER (WHERE x.fa IS NULL OR x.attempt < x.fa)
              AS failed_before_activation
          FROM (
            SELECT a.attempt, a.phase, a.activated_at, a.parked_at, st.at AS step_at,
              coalesce(a.steps @> '[{"step":"alert","outcome":"release_parked"}]'::jsonb, false)
                AS park_step,
              (
                a.phase IN ('failed', 'closing', 'lost')
                OR a.parked_at IS NOT NULL
                OR coalesce(a.steps @> '[{"step":"attempt_failed","outcome":"failed"}]'::jsonb, false)
                OR coalesce(a.steps @> '[{"step":"attempt_failed","outcome":"closing"}]'::jsonb, false)
              ) AS failed,
              min(a.attempt) FILTER (WHERE a.activated_at IS NOT NULL OR st.at IS NOT NULL) OVER ()
                AS fa
            FROM node_workload_attempts a
            LEFT JOIN LATERAL (
              SELECT min((e ->> 'at')::timestamptz) AS at
              FROM jsonb_array_elements(coalesce(a.steps, '[]'::jsonb)) AS e
              WHERE e ->> 'step' = 'activated' AND e ->> 'outcome' = 'ok'
            ) st ON true
            WHERE a.release_id = r.id
          ) x
        ) ag ON true
        WHERE r.created_at >= ${input.recordedFrom.toISOString()}::timestamptz
          AND r.created_at < ${input.to.toISOString()}::timestamptz
          ${this.scopeSql("r", input.scope)}
        ORDER BY r.created_at, r.id
        LIMIT ${input.maxRows + 1}
      `,
      input.signal
    );
    const facts: DeliveryReleaseFacts[] = rows
      .slice(0, input.maxRows)
      .map((r) => ({
        releaseId: String(r.id),
        nodeId: String(r.node_id),
        env: String(r.env),
        workload: String(r.workload),
        sourceSha: String(r.source_sha),
        createdBy: String(r.created_by),
        admissionRefusalReason:
          r.admission_refusal_reason == null
            ? undefined
            : String(r.admission_refusal_reason),
        createdAt: new Date(r.created_at as string | Date),
        activatedAt: date(r.activated_at),
        activatedStepAt: date(r.activated_step_at),
        served: r.served === true,
        parkedAt: date(r.parked_at),
        parkStepSeen: r.park_step_seen === true,
        current: r.current === true,
        firstActivatedAttempt:
          r.first_activated_attempt == null
            ? undefined
            : Number(r.first_activated_attempt),
        failedBeforeActivation: r.failed_before_activation === true,
      }));
    return {
      rows: facts,
      truncated: rows.length > input.maxRows,
      asOf: this.clock(),
    };
  }

  async servingLanes(input: {
    readonly scope: DeliveryScope;
    readonly maxRows: number;
    readonly signal: AbortSignal;
  }) {
    const s = this.sql;
    const rows = await cancellable(
      s`
        SELECT d.node_id, d.env, d.workload, d.release_id AS desired_release_id,
          dr.created_at AS desired_created_at,
          dr.spec -> 'expose' -> 'http' ->> 'host' AS host,
          coalesce(dr.spec -> 'health' ->> 'version', '/version') AS version_path,
          coalesce(dr.spec -> 'health' ->> 'ready', '/readyz') AS ready_path,
          act.release_id AS active_release_id,
          ar.source_sha AS expected_sha
        FROM node_workload_desired d
        JOIN node_workload_releases dr ON dr.id = d.release_id
        LEFT JOIN LATERAL (
          SELECT a.release_id
          FROM node_workload_attempts a
          JOIN node_workload_releases r2 ON r2.id = a.release_id
          WHERE r2.node_id = d.node_id AND r2.env = d.env AND r2.workload = d.workload
            AND a.phase = 'active'
          ORDER BY a.updated_at DESC
          LIMIT 1
        ) act ON true
        LEFT JOIN node_workload_releases ar ON ar.id = act.release_id
        WHERE d.state = 'running'
          AND dr.spec -> 'expose' -> 'http' ->> 'host' IS NOT NULL
          ${this.scopeSql("d", input.scope)}
        ORDER BY d.node_id, d.env, d.workload
        LIMIT ${input.maxRows + 1}
      `,
      input.signal
    );
    const lanes: DeliveryLaneFacts[] = rows
      .slice(0, input.maxRows)
      .map((r) => ({
        nodeId: String(r.node_id),
        env: String(r.env),
        workload: String(r.workload),
        host: String(r.host),
        versionPath: String(r.version_path),
        readyPath: String(r.ready_path),
        desiredReleaseId: String(r.desired_release_id),
        desiredCreatedAt: new Date(r.desired_created_at as string | Date),
        activeReleaseId:
          r.active_release_id == null ? undefined : String(r.active_release_id),
        expectedSha:
          r.expected_sha == null ? undefined : String(r.expected_sha),
      }));
    return {
      lanes,
      truncated: rows.length > input.maxRows,
      asOf: this.clock(),
    };
  }

  async probe(input: {
    readonly host: string;
    readonly path: string;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<DeliveryProbeResult> {
    input.signal.throwIfAborted();
    if (!HOST_RE.test(input.host) || !input.path.startsWith("/"))
      return { kind: "unreachable", code: "invalid_target" };
    const timeout = AbortSignal.timeout(input.timeoutMs);
    try {
      const res = await this.fetchImpl(`https://${input.host}${input.path}`, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        // With the caller's `cb=` query, keeps an edge cache from answering for the lane.
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: AbortSignal.any([input.signal, timeout]),
      });
      return {
        kind: "response",
        status: res.status,
        body: await readCapped(res, input.maxBytes),
      };
    } catch (error) {
      // The caller gave up: this probe could not run, so the reading is unknown.
      if (input.signal.aborted) throw error;
      return {
        kind: "unreachable",
        code: timeout.aborted ? "timeout" : "network",
      };
    }
  }
}

/** Read at most `maxBytes` of the body, then stop. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - offset);
    all.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= all.length) break;
  }
  return new TextDecoder().decode(all);
}
