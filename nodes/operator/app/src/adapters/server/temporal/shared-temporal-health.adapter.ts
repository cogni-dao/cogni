// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/temporal/shared-temporal-health`
 * Purpose: Read-only, server-observed health diagnostic for one node's shared Temporal queue.
 * Scope: Reads scheduler-worker build identity and Temporal pollers. Never starts workflows or mutates schedules/workers.
 * Invariants:
 *   - POLLERS_ARE_SERVER_OBSERVED: both Workflow and Activity pollers come from DescribeTaskQueue.
 *   - POLLER_IDENTITY_BINDS_ARTIFACT: both poller types report the exact scheduler-worker SHA and image digest returned by /version.
 *   - FRESH_OR_UNHEALTHY: the newest poll for each task type must be no older than 120 seconds.
 *   - ARTIFACT_IDENTITY_FAILS_CLOSED: unknown, placeholder, missing, or malformed source SHA/digest is unhealthy.
 *   - BOUNDED_DIAGNOSTIC: connection, RPC, and HTTP reads have deadlines; no retry loop.
 * Side-effects: IO (Temporal gRPC, scheduler-worker HTTP)
 * Links: docs/spec/temporal-patterns.md, story.5076, task.5238
 * @public
 */

import { Connection } from "@temporalio/client";

export const TEMPORAL_POLLER_MAX_AGE_MS = 120_000;
const CONNECT_TIMEOUT_MS = 1_200;
const RPC_TIMEOUT_MS = 1_500;
const WORKER_HTTP_TIMEOUT_MS = 1_200;
const MAX_FUTURE_SKEW_MS = 5_000;

export type SharedTemporalHealthReason =
  | "ok"
  | "app_identity_invalid"
  | "worker_unreachable"
  | "worker_identity_invalid"
  | "worker_identity_mixed"
  | "temporal_unavailable"
  | "workflow_poller_missing"
  | "workflow_poller_malformed"
  | "workflow_poller_stale"
  | "activity_poller_missing"
  | "activity_poller_malformed"
  | "activity_poller_stale";

export type SharedTemporalTaskType = "workflow" | "activity";

export interface AppVersionIdentity {
  readonly version: string;
  readonly buildSha: string;
  readonly buildTime: string | null;
}

export interface SchedulerWorkerVersionIdentity {
  readonly service: "scheduler-worker";
  readonly sha: string;
  readonly buildTs: string | null;
  readonly imageDigest: string;
}

export interface PollerHealth {
  readonly status: "fresh" | "missing" | "malformed" | "stale";
  readonly pollerCount: number;
  readonly freshestLastAccessAt: string | null;
  readonly freshestAgeMs: number | null;
}

export interface SharedTemporalHealth {
  readonly status: "healthy" | "unhealthy";
  readonly reason: SharedTemporalHealthReason;
  /** Explicitly names the centralized shared-worker lane; it is not node-sovereign. */
  readonly mode: "compatibility";
  readonly nodeId: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly app: AppVersionIdentity;
  readonly worker: SchedulerWorkerVersionIdentity | null;
  readonly pollers: Readonly<Record<SharedTemporalTaskType, PollerHealth>>;
  readonly checkedAt: string;
  readonly durationMs: number;
}

export interface SharedTemporalHealthConfig {
  readonly nodeId: string;
  readonly temporalAddress: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly schedulerWorkerHealthUrl: string;
  readonly app: AppVersionIdentity;
}

interface TimestampLike {
  readonly seconds?: number | string | bigint | { toString(): string } | null;
  readonly nanos?: number | null;
}

interface PollerLike {
  readonly identity?: string | null;
  readonly lastAccessTime?: TimestampLike | null;
}

interface DescribeTaskQueueResponseLike {
  readonly pollers?: readonly PollerLike[] | null;
}

interface AssessedPollers {
  readonly health: PollerHealth;
  readonly freshIdentities: readonly string[];
}

interface WorkflowServiceLike {
  describeTaskQueue(input: {
    namespace: string;
    taskQueue: { name: string };
    taskQueueType: number;
  }): Promise<DescribeTaskQueueResponseLike>;
}

interface TemporalConnectionLike {
  readonly workflowService: WorkflowServiceLike;
  withDeadline<T>(deadline: number | Date, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SharedTemporalHealthDeps {
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly connect?: (address: string) => Promise<TemporalConnectionLike>;
}

function isExactSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isExactDigest(value: string): boolean {
  return /^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/i.test(value);
}

function isSentinel(value: string): boolean {
  return /unknown|placeholder/i.test(value);
}

function normalizeDigest(value: string): string | null {
  const match = value.match(/sha256:[0-9a-f]{64}$/i);
  return match?.[0].toLowerCase() ?? null;
}

export function workerPollerIdentity(
  worker: SchedulerWorkerVersionIdentity
): string {
  const digest = normalizeDigest(worker.imageDigest);
  return digest
    ? `cogni:scheduler-worker:${worker.sha.toLowerCase()}:${digest}`
    : "cogni:scheduler-worker:invalid";
}

export function isValidAppIdentity(app: AppVersionIdentity): boolean {
  return (
    app.version.trim().length > 0 &&
    isExactSha(app.buildSha) &&
    !isSentinel(app.buildSha)
  );
}

export function parseWorkerIdentity(
  value: unknown
): SchedulerWorkerVersionIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.service !== "scheduler-worker" ||
    typeof record.sha !== "string" ||
    !isExactSha(record.sha) ||
    isSentinel(record.sha) ||
    typeof record.imageDigest !== "string" ||
    !isExactDigest(record.imageDigest) ||
    isSentinel(record.imageDigest)
  ) {
    return null;
  }
  const buildTs =
    typeof record.buildTs === "string" && !isSentinel(record.buildTs)
      ? record.buildTs
      : null;
  return {
    service: "scheduler-worker",
    sha: record.sha,
    buildTs,
    imageDigest: record.imageDigest,
  };
}

function timestampToMs(value: TimestampLike | null | undefined): number | null {
  if (value?.seconds == null) return null;
  try {
    const seconds = Number(value.seconds.toString());
    const nanos = Number(value.nanos ?? 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return seconds * 1_000 + Math.floor(nanos / 1_000_000);
  } catch {
    return null;
  }
}

export function assessPollers(
  pollers: readonly PollerLike[] | null | undefined,
  nowMs: number
): PollerHealth {
  const rows = pollers ?? [];
  if (rows.length === 0) {
    return {
      status: "missing",
      pollerCount: 0,
      freshestLastAccessAt: null,
      freshestAgeMs: null,
    };
  }

  const timestamps = rows
    .map((poller) => timestampToMs(poller.lastAccessTime))
    .filter((value): value is number => value !== null);
  if (timestamps.length !== rows.length) {
    return {
      status: "malformed",
      pollerCount: rows.length,
      freshestLastAccessAt: null,
      freshestAgeMs: null,
    };
  }

  const freshestMs = Math.max(...timestamps);
  const ageMs = nowMs - freshestMs;
  const fresh =
    ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= TEMPORAL_POLLER_MAX_AGE_MS;
  return {
    status: fresh ? "fresh" : "stale",
    pollerCount: rows.length,
    freshestLastAccessAt: new Date(freshestMs).toISOString(),
    freshestAgeMs: ageMs,
  };
}

function assessPollerDetails(
  pollers: readonly PollerLike[] | null | undefined,
  nowMs: number
): AssessedPollers {
  const rows = pollers ?? [];
  const health = assessPollers(rows, nowMs);
  if (health.status !== "fresh") return { health, freshIdentities: [] };

  const freshIdentities = [
    ...new Set(
      rows.flatMap((poller) => {
        const timestampMs = timestampToMs(poller.lastAccessTime);
        if (timestampMs === null || typeof poller.identity !== "string") {
          return [];
        }
        const ageMs = nowMs - timestampMs;
        return ageMs >= -MAX_FUTURE_SKEW_MS &&
          ageMs <= TEMPORAL_POLLER_MAX_AGE_MS
          ? [poller.identity]
          : [];
      })
    ),
  ];
  return { health, freshIdentities };
}

function reasonForPoller(
  taskType: SharedTemporalTaskType,
  health: PollerHealth
): SharedTemporalHealthReason | null {
  if (health.status === "fresh") return null;
  return `${taskType}_poller_${health.status}` as SharedTemporalHealthReason;
}

async function defaultConnect(
  address: string
): Promise<TemporalConnectionLike> {
  return Connection.connect({ address, connectTimeout: CONNECT_TIMEOUT_MS });
}

async function fetchWorkerVersion(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch
): Promise<{
  reachable: boolean;
  identity: SchedulerWorkerVersionIdentity | null;
}> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/version`, {
      signal: AbortSignal.timeout(WORKER_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return { reachable: false, identity: null };
    return {
      reachable: true,
      identity: parseWorkerIdentity(await response.json()),
    };
  } catch {
    return { reachable: false, identity: null };
  }
}

async function readPollers(
  connection: TemporalConnectionLike,
  config: SharedTemporalHealthConfig,
  nowMs: number
): Promise<Readonly<Record<SharedTemporalTaskType, AssessedPollers>>> {
  const read = async (taskQueueType: number): Promise<AssessedPollers> => {
    const response = await connection.withDeadline(
      Date.now() + RPC_TIMEOUT_MS,
      () =>
        connection.workflowService.describeTaskQueue({
          namespace: config.namespace,
          taskQueue: { name: config.taskQueue },
          // Temporal enum: WORKFLOW=1, ACTIVITY=2. Raw API is deliberate:
          // this endpoint needs server-observed pollers, not SDK local state.
          taskQueueType,
        })
    );
    return assessPollerDetails(response.pollers, nowMs);
  };

  const [workflow, activity] = await Promise.all([read(1), read(2)]);
  return { workflow, activity };
}

const EMPTY_POLLERS: Readonly<Record<SharedTemporalTaskType, PollerHealth>> = {
  workflow: {
    status: "missing",
    pollerCount: 0,
    freshestLastAccessAt: null,
    freshestAgeMs: null,
  },
  activity: {
    status: "missing",
    pollerCount: 0,
    freshestLastAccessAt: null,
    freshestAgeMs: null,
  },
};

export async function inspectSharedTemporalHealth(
  config: SharedTemporalHealthConfig,
  deps: SharedTemporalHealthDeps = {}
): Promise<SharedTemporalHealth> {
  const startedAt = performance.now();
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const checkedAt = new Date(nowMs).toISOString();
  const finish = (
    reason: SharedTemporalHealthReason,
    worker: SchedulerWorkerVersionIdentity | null,
    pollers: Readonly<Record<SharedTemporalTaskType, PollerHealth>>
  ): SharedTemporalHealth => ({
    status: reason === "ok" ? "healthy" : "unhealthy",
    reason,
    mode: "compatibility",
    nodeId: config.nodeId,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    app: config.app,
    worker,
    pollers,
    checkedAt,
    durationMs: Math.round(performance.now() - startedAt),
  });

  if (!isValidAppIdentity(config.app)) {
    return finish("app_identity_invalid", null, EMPTY_POLLERS);
  }

  const workerPromise = fetchWorkerVersion(
    config.schedulerWorkerHealthUrl,
    deps.fetch ?? globalThis.fetch
  );
  const pollersPromise = (async () => {
    const connection = await (deps.connect ?? defaultConnect)(
      config.temporalAddress
    );
    try {
      return await readPollers(connection, config, nowMs);
    } finally {
      await connection.close().catch(() => {});
    }
  })();

  const [workerResult, pollerResult] = await Promise.allSettled([
    workerPromise,
    pollersPromise,
  ]);
  const workerRead =
    workerResult.status === "fulfilled" ? workerResult.value : null;
  const pollers =
    pollerResult.status === "fulfilled"
      ? {
          workflow: pollerResult.value.workflow.health,
          activity: pollerResult.value.activity.health,
        }
      : EMPTY_POLLERS;

  if (!workerRead?.reachable) {
    return finish("worker_unreachable", null, pollers);
  }
  if (!workerRead.identity) {
    return finish("worker_identity_invalid", null, pollers);
  }
  if (pollerResult.status === "rejected") {
    return finish("temporal_unavailable", workerRead.identity, EMPTY_POLLERS);
  }

  const workflowReason = reasonForPoller("workflow", pollers.workflow);
  if (workflowReason)
    return finish(workflowReason, workerRead.identity, pollers);
  const activityReason = reasonForPoller("activity", pollers.activity);
  if (activityReason)
    return finish(activityReason, workerRead.identity, pollers);

  const expectedIdentity = workerPollerIdentity(workerRead.identity);
  const workflowIdentities = pollerResult.value.workflow.freshIdentities;
  const activityIdentities = pollerResult.value.activity.freshIdentities;
  if (workflowIdentities.length === 0 || activityIdentities.length === 0) {
    return finish("worker_identity_invalid", workerRead.identity, pollers);
  }
  if (
    workflowIdentities.length !== 1 ||
    activityIdentities.length !== 1 ||
    workflowIdentities[0] !== expectedIdentity ||
    activityIdentities[0] !== expectedIdentity
  ) {
    return finish("worker_identity_mixed", workerRead.identity, pollers);
  }
  return finish("ok", workerRead.identity, pollers);
}
