// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/temporal/ledger-diagnostic`
 * Purpose: Read exact admitted schedule, linked blockers and finite compatible pollers.
 * Scope: Request-local raw native RPCs only. Historical ownership remains explicitly unproven.
 * Invariants: Read-only; no hidden handshake, retries, list, query, payload output or shared client.
 * Side-effects: bounded Temporal reads; always closes its own channel.
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import {
  emptyLedgerDiagnostic,
  equalDiagnosticEnvelope,
  type LedgerDiagnosticBinding,
  type LedgerDiagnosticReason,
  type LedgerDiagnosticV1,
  ledgerDiagnosticSchema,
  type TemporalLedgerDiagnosticPort,
} from "@cogni/scheduler-core";
import { Connection } from "@temporalio/client";

type Native = Connection["workflowService"];
type Schedule = Awaited<ReturnType<Native["describeSchedule"]>>;
type Execution = Awaited<ReturnType<Native["describeWorkflowExecution"]>>;
type Queue = Awaited<ReturnType<Native["describeTaskQueue"]>>;
type Timestamp = {
  seconds?: number | { toString(): string } | null;
  nanos?: number | null;
};
class ShapeRefusal extends Error {
  constructor(readonly reason: LedgerDiagnosticReason) {
    super(reason);
  }
}
export class TemporalDiagnosticError extends Error {
  constructor(readonly code: "deadline_exceeded" | "temporal_read_failed") {
    super(code);
  }
}
function numeric(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : value && typeof value === "object" && "toString" in value
        ? Number(value.toString())
        : NaN;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ShapeRefusal("invalid_native_shape");
  return n;
}
function timestamp(value: Timestamp | null | undefined): string | null {
  if (!value) return null;
  const seconds = numeric(value.seconds ?? 0);
  const nanos = value.nanos ?? 0;
  if (
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1e9 ||
    seconds > 253402300799
  )
    throw new ShapeRefusal("invalid_native_shape");
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
}
function timeout(value: Timestamp | null | undefined): number | null {
  if (!value) return null;
  const seconds = numeric(value.seconds ?? 0);
  const nanos = value.nanos ?? 0;
  const ms = seconds * 1000 + nanos / 1e6;
  if (
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1e9 ||
    !Number.isSafeInteger(ms)
  )
    throw new ShapeRefusal("invalid_native_shape");
  return ms === 0 ? null : ms;
}
function bounded<T>(
  rows: readonly T[] | null | undefined,
  max: number
): readonly T[] {
  if (!rows) return [];
  if (!Array.isArray(rows)) throw new ShapeRefusal("invalid_native_shape");
  if (rows.length > max) throw new ShapeRefusal("bounds_exceeded");
  return rows;
}
function reference(ref: {
  workflowId?: string | null;
  runId?: string | null;
}): { workflowId: string; runId: string } {
  if (
    !ref.workflowId ||
    ref.workflowId.length > 256 ||
    !ref.runId ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      ref.runId
    )
  )
    throw new ShapeRefusal("invalid_native_shape");
  return { workflowId: ref.workflowId, runId: ref.runId };
}
function references(reply: Schedule) {
  const refs = bounded(reply.info?.runningWorkflows, 4).map(reference);
  const keys = refs.map((r) => JSON.stringify(r)).sort();
  if (new Set(keys).size !== keys.length)
    throw new ShapeRefusal("invalid_native_shape");
  return { refs, key: JSON.stringify(keys) };
}
function token(reply: Schedule): string {
  if (
    !reply.conflictToken ||
    reply.conflictToken.length === 0 ||
    reply.conflictToken.length > 256
  )
    throw new ShapeRefusal("invalid_native_shape");
  return Buffer.from(reply.conflictToken).toString("base64");
}
function scheduleProjection(
  reply: Schedule,
  binding: LedgerDiagnosticBinding
): NonNullable<LedgerDiagnosticV1["schedule"]> {
  if (!reply.info || !reply.schedule?.policies || !reply.schedule.state)
    throw new ShapeRefusal("invalid_native_shape");
  const action = reply.schedule?.action?.startWorkflow;
  const payloads = action?.input?.payloads;
  if (
    !action ||
    action.workflowType?.name !== binding.workflowType ||
    !payloads ||
    payloads.length !== 1
  )
    throw new ShapeRefusal("scope_conflict");
  const p = payloads[0];
  if (
    !p?.data ||
    p.data.length > 65536 ||
    !p.metadata?.encoding ||
    Buffer.from(p.metadata.encoding).toString("utf8") !== "json/plain" ||
    Object.keys(p.metadata).some((k) => k !== "encoding")
  )
    throw new ShapeRefusal("ownership_unproven");
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(p.data).toString("utf8"));
  } catch {
    throw new ShapeRefusal("ownership_unproven");
  }
  if (!equalDiagnosticEnvelope(envelope, binding.expectedEnvelope))
    throw new ShapeRefusal("scope_conflict");
  if (action.taskQueue?.name !== binding.currentQueue)
    throw new ShapeRefusal("scope_conflict");
  const future = bounded(reply.info?.futureActionTimes, 10).map((t) =>
    timestamp(t)
  );
  if (
    future.some((t) => t === null) ||
    future.some((t, i) => i > 0 && (t ?? "") < (future[i - 1] ?? ""))
  )
    throw new ShapeRefusal("invalid_native_shape");
  bounded(reply.info?.recentActions, 16);
  references(reply);
  token(reply);
  const overlap = reply.schedule?.policies?.overlapPolicy;
  return {
    ownership: "owned",
    observedAt: new Date().toISOString(),
    state: reply.schedule?.state?.paused ? "paused" : "active",
    overlap:
      overlap === 1
        ? "SKIP"
        : overlap === 2
          ? "BUFFER_ONE"
          : overlap === 6
            ? "ALLOW_ALL"
            : "unknown",
    overlapSkipped: numeric(reply.info?.overlapSkipped ?? 0),
    actionCount: numeric(reply.info?.actionCount ?? 0),
    missedCatchup: numeric(reply.info?.missedCatchupWindow ?? 0),
    nextActionAt: future[0] ?? null,
    currentQueueRole: "current",
    executionTimeoutMs: timeout(action.workflowExecutionTimeout),
    runTimeoutMs: timeout(action.workflowRunTimeout),
  };
}
function projectBlocker(
  reply: Execution,
  binding: LedgerDiagnosticBinding
): NonNullable<LedgerDiagnosticV1["blocker"]> {
  const info = reply.workflowExecutionInfo;
  const config = reply.executionConfig;
  if (!info || !config || !timestamp(info.startTime))
    throw new ShapeRefusal("invalid_native_shape");
  bounded(reply.pendingActivities, 16);
  bounded(reply.pendingChildren, 16);
  const task = reply.pendingWorkflowTask;
  const queue = config.taskQueue?.name;
  if (!queue || queue.length > 256)
    throw new ShapeRefusal("invalid_native_shape");
  const role =
    queue === binding.currentQueue
      ? "current"
      : queue === binding.legacyQueue
        ? "legacy"
        : "other";
  return {
    ownership: role === "other" ? "scope_conflict" : "unproven",
    evidenceScope: "environment-shared",
    observedAt: new Date().toISOString(),
    state: info.status === 1 ? "RUNNING" : "changed",
    startedAt: timestamp(info.startTime),
    closedAt: timestamp(info.closeTime),
    pendingWorkflowTask: task
      ? {
          state:
            task.state === 1
              ? "scheduled"
              : task.state === 2
                ? "started"
                : "unknown",
          scheduledAt: timestamp(task.scheduledTime),
          originalScheduledAt: timestamp(task.originalScheduledTime),
          startedAt: timestamp(task.startedTime),
          attempt: task.attempt == null ? null : numeric(task.attempt),
        }
      : null,
    executionTimeoutMs: timeout(config.workflowExecutionTimeout),
    runTimeoutMs: timeout(config.workflowRunTimeout),
    taskTimeoutMs: timeout(config.defaultWorkflowTaskTimeout),
    runningQueueRole: role,
    queueChanged: role === "other" ? null : role === "legacy",
  };
}
function projectPollers(
  reply: Queue
): NonNullable<LedgerDiagnosticV1["queues"][number]["workflow"]> {
  // Older/default servers may omit an empty repeated field. protobuf decoding supplies [].
  if (!Array.isArray(reply.pollers)) throw new ShapeRefusal("pollers_unknown");
  const times = bounded(reply.pollers, 64)
    .map((p) => timestamp(p.lastAccessTime))
    .filter((t): t is string => t !== null)
    .sort();
  const last = times.at(-1) ?? null;
  const now = Date.now();
  if (last && Date.parse(last) > now)
    throw new ShapeRefusal("invalid_native_shape");
  return {
    observedAt: new Date(now).toISOString(),
    pollerCount: reply.pollers.length,
    lastAccessAt: last,
    ageMs: last ? now - Date.parse(last) : null,
    freshness: last ? "observed" : "unknown",
  };
}

export class TemporalLedgerDiagnosticAdapter
  implements TemporalLedgerDiagnosticPort
{
  constructor(
    private readonly address: string,
    private readonly makeConnection: typeof Connection.lazy = (options) =>
      Connection.lazy(options)
  ) {}
  async read(
    binding: LedgerDiagnosticBinding,
    options: { signal: AbortSignal; deadline: number }
  ): Promise<LedgerDiagnosticV1> {
    const result = emptyLedgerDiagnostic(binding);
    const signal = options.signal;
    const deadline = Math.min(options.deadline, Date.now() + 3500);
    let connection: Connection | undefined;
    let closed = false;
    const close = () => {
      if (connection && !closed) {
        closed = true;
        void connection.close();
      }
    };
    const check = () => {
      if (signal.aborted || Date.now() >= deadline)
        throw new TemporalDiagnosticError("deadline_exceeded");
    };
    const abort = () => close();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(close, Math.max(0, deadline - Date.now()));
    const reason = (code: LedgerDiagnosticReason) => {
      if (!result.reasonCodes.includes(code)) result.reasonCodes.push(code);
    };
    const rpc = async <T>(
      call: (service: Native) => Promise<T>
    ): Promise<T> => {
      check();
      if (!connection || result.budgets.calls >= 12)
        throw new ShapeRefusal("bounds_exceeded");
      const conn = connection;
      return conn.withDeadline(Math.min(deadline, Date.now() + 1000), () =>
        conn.withAbortSignal(signal, () => {
          check();
          result.budgets.calls += 1;
          return call(conn.workflowService);
        })
      );
    };
    try {
      check();
      connection = this.makeConnection({
        address: this.address,
        plugins: [],
        interceptors: [],
        channelArgs: {
          "grpc.enable_retries": 0,
          "grpc.max_receive_message_length": 262144,
          "grpc.max_send_message_length": 16384,
        },
      });
      check();
      const request = {
        namespace: binding.namespace,
        scheduleId: binding.scheduleId,
      };
      const initial = await rpc((s) => s.describeSchedule(request));
      // The actual channel enforces wire bytes, including payloads we never serialize.
      result.schedule = scheduleProjection(initial, binding);
      const original = references(initial);
      const initialToken = token(initial);
      result.blockingRunningCount = original.refs.length;
      const candidates: {
        ref: { workflowId: string; runId: string };
        blocker: NonNullable<LedgerDiagnosticV1["blocker"]>;
      }[] = [];
      for (const ref of original.refs) {
        try {
          const reply = await rpc((s) =>
            s.describeWorkflowExecution({
              namespace: binding.namespace,
              execution: ref,
            })
          );
          const actual = reference(
            reply.workflowExecutionInfo?.execution ?? {}
          );
          if (
            actual.workflowId !== ref.workflowId ||
            actual.runId !== ref.runId
          )
            throw new ShapeRefusal("invalid_native_shape");
          candidates.push({ ref, blocker: projectBlocker(reply, binding) });
        } catch (error) {
          if (signal.aborted || Date.now() >= deadline)
            throw new TemporalDiagnosticError("deadline_exceeded");
          reason("selection_incomplete");
          result.selection = "incomplete";
          if (error instanceof ShapeRefusal) reason(error.reason);
        }
      }
      if (result.selection !== "incomplete") {
        if (candidates.some((c) => c.blocker.state !== "RUNNING")) {
          reason("blocker_changed");
          result.selection = "incomplete";
        } else if (candidates.length) {
          candidates.sort(
            (a, b) =>
              (a.blocker.startedAt ?? "").localeCompare(
                b.blocker.startedAt ?? ""
              ) ||
              a.ref.workflowId.localeCompare(b.ref.workflowId) ||
              a.ref.runId.localeCompare(b.ref.runId)
          );
          result.blocker = candidates[0]?.blocker ?? null;
          result.selection = "oldest_running";
          reason("historical_ownership_unproven");
        } else {
          reason("no_running_reference");
        }
      }
      const queueRoles: ("current" | "legacy")[] = ["current"];
      if (
        result.blocker?.runningQueueRole === "legacy" &&
        binding.currentQueue !== binding.legacyQueue
      )
        queueRoles.push("legacy");
      for (const role of queueRoles) {
        const queue: LedgerDiagnosticV1["queues"][number] = {
          role,
          evidenceScope: "environment-shared",
          workflow: null,
          activity: null,
        };
        for (const [key, taskQueueType] of [
          ["workflow", 1],
          ["activity", 2],
        ] as const) {
          try {
            queue[key] = projectPollers(
              await rpc((s) =>
                s.describeTaskQueue({
                  namespace: binding.namespace,
                  taskQueue: {
                    name:
                      role === "current"
                        ? binding.currentQueue
                        : binding.legacyQueue,
                    kind: 1,
                  },
                  taskQueueType,
                })
              )
            );
          } catch (error) {
            if (signal.aborted || Date.now() >= deadline)
              throw new TemporalDiagnosticError("deadline_exceeded");
            reason(
              error instanceof ShapeRefusal ? error.reason : "pollers_unknown"
            );
          }
        }
        result.queues.push(queue);
      }
      const final = await rpc((s) => s.describeSchedule(request));
      scheduleProjection(final, binding);
      result.consistent =
        token(final) === initialToken && references(final).key === original.key;
      if (!result.consistent) reason("evidence_changed");
      const b = result.blocker;
      if (b) {
        if (b.executionTimeoutMs === null) reason("no_execution_timeout");
        if (b.runTimeoutMs === null) reason("no_run_timeout");
        if (b.executionTimeoutMs === null && b.runTimeoutMs === null)
          reason("unbounded_blocker");
        if (
          result.consistent &&
          result.selection === "oldest_running" &&
          b.state === "RUNNING" &&
          b.pendingWorkflowTask?.state === "scheduled" &&
          b.pendingWorkflowTask.scheduledAt &&
          !b.pendingWorkflowTask.startedAt &&
          b.runningQueueRole === "legacy" &&
          result.queues.find((q) => q.role === "legacy")?.workflow
            ?.pollerCount === 0 &&
          result.schedule.overlap === "SKIP" &&
          (result.schedule.overlapSkipped ?? 0) > 0
        )
          reason("stranded_on_unpolled_legacy_queue");
      }
      result.budgets.complete =
        result.consistent &&
        result.selection !== "incomplete" &&
        result.queues.every((q) => q.workflow !== null && q.activity !== null);
      result.state = result.budgets.complete ? "observed" : "partial";
    } catch (error) {
      if (
        signal.aborted ||
        Date.now() >= deadline ||
        error instanceof TemporalDiagnosticError
      )
        throw new TemporalDiagnosticError("deadline_exceeded");
      if (error instanceof ShapeRefusal) {
        result.state = result.schedule ? "partial" : "unknown";
        reason(error.reason);
        result.budgets.complete = false;
      } else if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 4
      )
        throw new TemporalDiagnosticError("deadline_exceeded");
      else if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 5
      ) {
        reason("schedule_missing");
      } else if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 8
      ) {
        reason("bounds_exceeded");
        result.state = "partial";
      } else throw new TemporalDiagnosticError("temporal_read_failed");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      close();
    }
    const safe = ledgerDiagnosticSchema.parse(result);
    if (Buffer.byteLength(JSON.stringify(safe)) > 16384)
      throw new TemporalDiagnosticError("temporal_read_failed");
    return safe;
  }
}
