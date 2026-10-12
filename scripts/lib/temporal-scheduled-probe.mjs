// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/temporal-scheduled-probe`
 * Purpose: Prove one node's existing schedule → shared worker → LangGraph path.
 * Scope: Authenticated public node APIs plus an injected Loki reader. Does not
 *   access a database or Temporal directly, or import runtime product code.
 * Invariants:
 *   - Uses the existing schedule and agent-run APIs only.
 *   - Uses the platform free model with its bare model ID.
 *   - Identifies the exact new graphRunId by diffing the caller's run ledger.
 *   - Always attempts schedule deletion and proves API-level absence.
 *   - Requires one Loki record correlated by both scheduleId and graphRunId.
 * Side-effects: IO (remote HTTP reads/writes through injected or global fetch)
 * Links: task.5239, docs/guides/agent-api-validation.md
 * @public
 */

import { randomUUID } from "node:crypto";

const TERMINAL_STATUSES = new Set(["success", "error", "skipped", "cancelled"]);

export class TemporalScheduledProbeError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "TemporalScheduledProbeError";
    this.phase = options.phase ?? "unknown";
    this.evidence = options.evidence ?? null;
  }
}

function trimBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new TypeError("target.baseUrl is required");
  }
  return baseUrl.replace(/\/$/, "");
}

function nextSafeMinute(now) {
  const next = new Date(Math.ceil(now.getTime() / 60_000) * 60_000 + 60_000);
  next.setUTCSeconds(0, 0);
  return next;
}

export function cronForUtcMinute(date) {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

function authHeaders(apiKey, hasBody = false) {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new TypeError("target.apiKey is required");
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

async function readJson(response, phase) {
  const text = await response.text();
  if (!response.ok) {
    throw new TemporalScheduledProbeError(
      `${phase} failed with HTTP ${response.status}${text ? `: ${text}` : ""}`,
      { phase }
    );
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new TemporalScheduledProbeError(`${phase} returned invalid JSON`, {
      phase,
      cause,
    });
  }
}

async function fetchJson(fetchImpl, url, init, phase, requestTimeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (cause) {
    throw new TemporalScheduledProbeError(`${phase} request failed`, {
      phase,
      cause,
    });
  }
  return readJson(response, phase);
}

async function fetchStatus(fetchImpl, url, init, phase, requestTimeoutMs) {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (cause) {
    throw new TemporalScheduledProbeError(`${phase} request failed`, {
      phase,
      cause,
    });
  }
}

function parseRuns(body, phase) {
  if (!body || !Array.isArray(body.runs)) {
    throw new TemporalScheduledProbeError(
      `${phase} response is missing runs[]`,
      { phase }
    );
  }
  return body.runs;
}

async function listScheduledRuns(deps, target) {
  const url = `${target.baseUrl}/api/v1/agent/runs?runKind=system_scheduled&limit=100`;
  const body = await fetchJson(
    deps.fetchImpl,
    url,
    { headers: authHeaders(target.apiKey) },
    "list_runs",
    deps.requestTimeoutMs
  );
  return parseRuns(body, "list_runs");
}

async function waitForExactTerminalRun(deps, target, baselineRunIds) {
  const deadline = deps.monotonicNow() + deps.timeoutMs;
  let graphRunId = null;

  while (deps.monotonicNow() < deadline) {
    const runs = await listScheduledRuns(deps, target);
    const newRuns = runs.filter(
      (run) =>
        run?.runKind === "system_scheduled" &&
        run?.graphId === deps.graphId &&
        typeof run?.runId === "string" &&
        !baselineRunIds.has(run.runId)
    );

    if (!graphRunId && newRuns.length > 1) {
      throw new TemporalScheduledProbeError(
        `run correlation is ambiguous: ${newRuns.length} new scheduled runs`,
        {
          phase: "wait_run",
          evidence: { newRunIds: newRuns.map((r) => r.runId) },
        }
      );
    }
    if (!graphRunId && newRuns.length === 1) {
      graphRunId = newRuns[0].runId;
    }

    if (graphRunId) {
      const exactRun = runs.find((run) => run?.runId === graphRunId);
      if (exactRun && TERMINAL_STATUSES.has(exactRun.status)) {
        if (exactRun.status !== "success") {
          throw new TemporalScheduledProbeError(
            `scheduled graph run ${graphRunId} ended ${exactRun.status}`,
            { phase: "terminal_run", evidence: exactRun }
          );
        }
        return exactRun;
      }
    }

    await deps.sleep(deps.pollIntervalMs);
  }

  throw new TemporalScheduledProbeError(
    graphRunId
      ? `scheduled graph run ${graphRunId} did not reach terminal status`
      : "no new scheduled graph run appeared",
    { phase: "wait_run", evidence: { graphRunId } }
  );
}

function normalizeLokiEntries(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.entries)) return result.entries;
  return [];
}

function requireCorrelatedLokiEvidence(result, scheduleId, graphRunId) {
  const entries = normalizeLokiEntries(result);
  const completion = result?.completion;
  if (
    !completion ||
    completion.event !== "worker.activity.graph_completed" ||
    completion.scheduleId !== scheduleId ||
    completion.graphRunId !== graphRunId ||
    completion.workflowId !== scheduleId ||
    typeof completion.temporalRunId !== "string" ||
    completion.temporalRunId.length === 0
  ) {
    throw new TemporalScheduledProbeError(
      "Loki returned no exact graph completion identity",
      { phase: "loki", evidence: { scheduleId, graphRunId } }
    );
  }
  return {
    completion,
    entryCount: entries.length,
    ...(result?.sourceUrl ? { sourceUrl: result.sourceUrl } : {}),
  };
}

async function cleanupSchedule(deps, target, scheduleId, probeId) {
  let deleteResponse = null;
  let deleteError = null;
  for (let attempt = 1; attempt <= deps.cleanupAttempts; attempt += 1) {
    try {
      deleteResponse = await fetchStatus(
        deps.fetchImpl,
        `${target.baseUrl}/api/v1/schedules/${encodeURIComponent(scheduleId)}`,
        { method: "DELETE", headers: authHeaders(target.apiKey) },
        "delete_schedule",
        deps.requestTimeoutMs
      );
      if (deleteResponse.status === 204 || deleteResponse.status === 404) break;
      if (deleteResponse.status < 500) {
        const body = await deleteResponse.text();
        throw new TemporalScheduledProbeError(
          `delete_schedule failed with HTTP ${deleteResponse.status}${body ? `: ${body}` : ""}`,
          { phase: "delete_schedule" }
        );
      }
      deleteError = new TemporalScheduledProbeError(
        `delete_schedule failed with HTTP ${deleteResponse.status}`,
        { phase: "delete_schedule" }
      );
    } catch (error) {
      deleteError = error;
      deleteResponse = null;
    }
    if (attempt < deps.cleanupAttempts) await deps.sleep(deps.cleanupRetryMs);
  }
  if (!deleteResponse || ![204, 404].includes(deleteResponse.status)) {
    throw deleteError;
  }

  const listed = await fetchJson(
    deps.fetchImpl,
    `${target.baseUrl}/api/v1/schedules`,
    { headers: authHeaders(target.apiKey) },
    "verify_schedule_absent",
    deps.requestTimeoutMs
  );
  if (!listed || !Array.isArray(listed.schedules)) {
    throw new TemporalScheduledProbeError(
      "verify_schedule_absent response is missing schedules[]",
      { phase: "verify_schedule_absent" }
    );
  }
  if (
    listed.schedules.some(
      (schedule) =>
        schedule?.id === scheduleId ||
        JSON.stringify(schedule?.input ?? {}).includes(probeId)
    )
  ) {
    throw new TemporalScheduledProbeError(
      `probe schedule ${scheduleId} still exists after DELETE`,
      { phase: "verify_schedule_absent" }
    );
  }
  return { deleteStatus: deleteResponse.status, absent: true };
}

async function findProbeScheduleIds(deps, target, probeId) {
  const listed = await fetchJson(
    deps.fetchImpl,
    `${target.baseUrl}/api/v1/schedules`,
    { headers: authHeaders(target.apiKey) },
    "discover_probe_schedule",
    deps.requestTimeoutMs
  );
  if (!listed || !Array.isArray(listed.schedules)) {
    throw new TemporalScheduledProbeError(
      "discover_probe_schedule response is missing schedules[]",
      { phase: "discover_probe_schedule" }
    );
  }
  return listed.schedules
    .filter((schedule) =>
      JSON.stringify(schedule?.input ?? {}).includes(probeId)
    )
    .map((schedule) => schedule?.id)
    .filter((id) => typeof id === "string");
}

/**
 * Run one bounded scheduled LangGraph probe against one node.
 *
 * `readLokiEvidence` is deliberately injected: the caller owns operator auth
 * and node/env selection, while this harness owns the correlation invariant.
 */
export async function proveScheduledLangGraph(targetInput, options = {}) {
  if (typeof options.readLokiEvidence !== "function") {
    throw new TypeError("readLokiEvidence callback is required");
  }

  const target = {
    ...targetInput,
    baseUrl: trimBaseUrl(targetInput?.baseUrl),
  };
  const deps = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    readLokiEvidence: options.readLokiEvidence,
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    wallClock: options.wallClock ?? (() => new Date()),
    monotonicNow: options.monotonicNow ?? Date.now,
    makeProbeId: options.makeProbeId ?? randomUUID,
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    pollIntervalMs: options.pollIntervalMs ?? 2_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    cleanupAttempts: options.cleanupAttempts ?? 3,
    cleanupRetryMs: options.cleanupRetryMs ?? 1_000,
    graphId: options.graphId ?? "langgraph:poet",
  };
  if (typeof deps.fetchImpl !== "function") {
    throw new TypeError("fetch implementation is required");
  }

  const baselineRuns = await listScheduledRuns(deps, target);
  const baselineRunIds = new Set(
    baselineRuns
      .map((run) => run?.runId)
      .filter((runId) => typeof runId === "string")
  );
  const scheduledAt = nextSafeMinute(deps.wallClock());
  const probeId = deps.makeProbeId();
  let scheduleId = null;
  let primaryError = null;
  let result = null;
  let cleanup = null;

  try {
    const created = await fetchJson(
      deps.fetchImpl,
      `${target.baseUrl}/api/v1/schedules`,
      {
        method: "POST",
        headers: authHeaders(target.apiKey, true),
        body: JSON.stringify({
          graphId: deps.graphId,
          input: {
            messages: [
              {
                role: "user",
                content: `Reply with exactly TEMPORAL_PROBE_OK ${probeId}`,
              },
            ],
            modelRef: {
              providerKey: "platform",
              modelId: "gpt-oss-120b",
            },
          },
          cron: cronForUtcMinute(scheduledAt),
          timezone: "UTC",
        }),
      },
      "create_schedule",
      deps.requestTimeoutMs
    );
    if (typeof created?.id !== "string") {
      throw new TemporalScheduledProbeError(
        "create_schedule response is missing id",
        { phase: "create_schedule" }
      );
    }
    scheduleId = created.id;

    const terminalRun = await waitForExactTerminalRun(
      deps,
      target,
      baselineRunIds
    );
    const lokiRaw = await deps.readLokiEvidence({
      target,
      scheduleId,
      graphRunId: terminalRun.runId,
      scheduledAt: scheduledAt.toISOString(),
      timeoutMs: deps.timeoutMs,
    });
    const loki = requireCorrelatedLokiEvidence(
      lokiRaw,
      scheduleId,
      terminalRun.runId
    );

    result = {
      target: target.name ?? target.baseUrl,
      baseUrl: target.baseUrl,
      scheduleId,
      scheduledAt: scheduledAt.toISOString(),
      graphRunId: terminalRun.runId,
      terminalStatus: terminalRun.status,
      loki,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      // A create response can be lost after the server commits. Recover by the
      // unique probe marker before deciding there is nothing to delete.
      const cleanupIds = scheduleId
        ? [scheduleId]
        : await findProbeScheduleIds(deps, target, probeId);
      for (const cleanupId of cleanupIds) {
        const cleaned = await cleanupSchedule(
          deps,
          target,
          cleanupId,
          probeId
        );
        if (cleanupId === scheduleId) cleanup = cleaned;
      }
    } catch (error) {
      if (primaryError) {
        primaryError = new AggregateError(
          [primaryError, error],
          "scheduled probe and cleanup both failed"
        );
      } else {
        primaryError = error;
      }
    }
  }

  if (primaryError) throw primaryError;
  return { ...result, cleanup };
}

/** Run targets sequentially to avoid overlapping billable graph execution. */
export async function proveScheduledLangGraphTargets(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError("at least one target is required");
  }
  const results = [];
  for (const target of targets) {
    results.push(await proveScheduledLangGraph(target, options));
  }
  return results;
}
