// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/temporal-proof-orchestrator`
 * Purpose: Compose every Temporal diagnostic stage into one fail-closed proof.
 * Scope: Orchestrates public node APIs and Loki. Does not deploy or promote.
 * Invariants:
 *   - Registers exactly one ephemeral actor per target and reuses that key.
 *   - Runs only the fixed free-model probes owned by the chat/schedule helpers.
 *   - Never returns issued API keys or Grafana credentials.
 *   - Scheduled target execution remains sequential.
 * Side-effects: IO (remote actor registration, chat run, and temporary schedules)
 * Links: story.5076, task.5238, task.5239
 * @public
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { runTemporalChatProbe } from "./temporal-chat-probe.mjs";
import {
  defaultBaseUrl,
  readTemporalHealth,
  TEMPORAL_HEALTH_CLI_REASON,
} from "./temporal-health-client.mjs";
import {
  createTemporalLokiEvidenceReader,
  TemporalLokiEvidenceError,
} from "./temporal-loki-evidence.mjs";
import {
  proveScheduledLangGraphTargets,
  TemporalScheduledProbeError,
} from "./temporal-scheduled-probe.mjs";

const TARGET_NAMES = ["poly", "node-template"];
const ENVIRONMENTS = new Set(["candidate-a", "preview", "production"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/i;

export class TemporalProofError extends Error {
  constructor(reason, options = {}) {
    super(options.message ?? reason);
    this.name = "TemporalProofError";
    this.reason = reason;
    this.phase = options.phase ?? "unknown";
    this.target = options.target ?? null;
  }
}

function normalizeUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
      { phase: "configuration", target: name }
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
      { phase: "configuration", target: name }
    );
  }
  return parsed.origin;
}

export function resolveTemporalProofTargets({
  repoRoot,
  environment,
  urls = {},
  expectedShas = {},
}) {
  if (environment !== undefined && !ENVIRONMENTS.has(environment)) {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
      { phase: "configuration" }
    );
  }

  return TARGET_NAMES.map((name) => {
    const catalogPath = path.join(repoRoot, "infra", "catalog", `${name}.yaml`);
    let row;
    try {
      row = parseYaml(fs.readFileSync(catalogPath, "utf8"));
    } catch {
      throw new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
        { phase: "configuration", target: name }
      );
    }
    const targetEnvironment = environment ?? row?.activity_env;
    const expectedSourceSha = expectedShas[name] ?? row?.source_sha;
    if (
      !ENVIRONMENTS.has(targetEnvironment) ||
      !Array.isArray(row?.envs) ||
      !row.envs.includes(targetEnvironment) ||
      typeof row?.node_id !== "string" ||
      !UUID_PATTERN.test(row.node_id) ||
      typeof expectedSourceSha !== "string" ||
      !SHA_PATTERN.test(expectedSourceSha)
    ) {
      throw new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
        { phase: "configuration", target: name }
      );
    }
    return {
      name,
      nodeId: row.node_id,
      sourceSha: expectedSourceSha,
      environment: targetEnvironment,
      baseUrl: normalizeUrl(
        urls[name] ?? defaultBaseUrl(name, targetEnvironment),
        name
      ),
    };
  });
}

export async function registerTemporalProbeActor(
  target,
  options = {},
  dependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const nonce = dependencies.nonce ?? (() => randomUUID().slice(0, 8));
  const timeoutMs = options.timeoutMs ?? 15_000;
  let response;
  try {
    response = await fetchImpl(`${target.baseUrl}/api/v1/agent/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `temporal-health-${target.name}-${now()}-${nonce()}`,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.REGISTRATION_FAILED,
      { phase: "registration", target: target.name }
    );
  }
  if (!response?.ok) {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.REGISTRATION_FAILED,
      { phase: "registration", target: target.name }
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.REGISTRATION_FAILED,
      { phase: "registration", target: target.name }
    );
  }
  if (typeof body?.apiKey !== "string" || body.apiKey.length === 0) {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.REGISTRATION_FAILED,
      { phase: "registration", target: target.name }
    );
  }
  return body.apiKey;
}

function scheduledFailure(error, target) {
  if (error instanceof TemporalProofError) return error;
  if (error instanceof AggregateError) {
    return scheduledFailure(error.errors[0], target);
  }
  if (error instanceof TemporalLokiEvidenceError) {
    return new TemporalProofError(
      error.phase === "configuration"
        ? TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID
        : TEMPORAL_HEALTH_CLI_REASON.LOKI_EVIDENCE_MISSING,
      { phase: error.phase, target }
    );
  }
  if (error instanceof TemporalScheduledProbeError) {
    if (error.phase === "wait_run") {
      return new TemporalProofError(
        error.evidence?.graphRunId
          ? TEMPORAL_HEALTH_CLI_REASON.EXECUTION_STALE
          : TEMPORAL_HEALTH_CLI_REASON.RECENT_TERMINAL_MISSING,
        { phase: error.phase, target }
      );
    }
    if (error.phase === "terminal_run") {
      return new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.EXECUTION_FAILED,
        { phase: error.phase, target }
      );
    }
    if (error.phase === "loki") {
      return new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.LOKI_EVIDENCE_MISSING,
        { phase: error.phase, target }
      );
    }
    return new TemporalProofError(TEMPORAL_HEALTH_CLI_REASON.SCHEDULE_DRIFT, {
      phase: error.phase,
      target,
    });
  }
  return new TemporalProofError(TEMPORAL_HEALTH_CLI_REASON.SCHEDULE_DRIFT, {
    phase: "scheduled_probe",
    target,
  });
}

export function temporalProofFailure(error) {
  if (error instanceof TemporalProofError) {
    return {
      status: "error",
      reason: error.reason,
      phase: error.phase,
      ...(error.target ? { target: error.target } : {}),
    };
  }
  return {
    status: "error",
    reason: TEMPORAL_HEALTH_CLI_REASON.REQUEST_FAILED,
    phase: "unknown",
  };
}

export async function runTemporalHealthProof(options = {}, dependencies = {}) {
  const targets =
    options.targets ??
    resolveTemporalProofTargets({
      repoRoot: options.repoRoot ?? process.cwd(),
      environment: options.environment,
      urls: options.urls,
      expectedShas: options.expectedShas,
    });
  if (
    !Array.isArray(targets) ||
    targets.length !== 2 ||
    targets.map((target) => target.name).join(",") !== TARGET_NAMES.join(",")
  ) {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
      { phase: "configuration" }
    );
  }

  const registerActor =
    dependencies.registerActor ?? registerTemporalProbeActor;
  const readHealth = dependencies.readHealth ?? readTemporalHealth;
  const runChat = dependencies.runChat ?? runTemporalChatProbe;
  const runScheduled =
    dependencies.runScheduled ?? proveScheduledLangGraphTargets;

  let readLokiEvidence;
  try {
    readLokiEvidence =
      dependencies.readLokiEvidence ??
      (dependencies.createLokiReader ?? createTemporalLokiEvidenceReader)(
        options.loki
      );
  } catch (error) {
    throw scheduledFailure(error, "loki");
  }

  const authenticated = [];
  for (const target of targets) {
    let apiKey;
    try {
      apiKey = await registerActor(target, options.registration);
    } catch (error) {
      if (error instanceof TemporalProofError) throw error;
      throw new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.REGISTRATION_FAILED,
        { phase: "registration", target: target.name }
      );
    }
    authenticated.push({ ...target, apiKey });
  }

  const health = [];
  let sharedWorker = null;
  for (const target of authenticated) {
    let result;
    try {
      result = await readHealth({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        timeoutMs: options.healthTimeoutMs,
      });
    } catch {
      throw new TemporalProofError(TEMPORAL_HEALTH_CLI_REASON.REQUEST_FAILED, {
        phase: "health",
        target: target.name,
      });
    }
    if (result?.exitCode !== 0) {
      throw new TemporalProofError(
        typeof result?.body?.reason === "string"
          ? result.body.reason
          : TEMPORAL_HEALTH_CLI_REASON.REQUEST_FAILED,
        { phase: "health", target: target.name }
      );
    }
    if (
      result.body?.nodeId !== target.nodeId ||
      typeof result.body?.app?.buildSha !== "string" ||
      !SHA_PATTERN.test(result.body.app.buildSha) ||
      typeof result.body?.worker?.sha !== "string" ||
      !SHA_PATTERN.test(result.body.worker.sha) ||
      typeof result.body?.worker?.imageDigest !== "string" ||
      !DIGEST_PATTERN.test(result.body.worker.imageDigest)
    ) {
      throw new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.RESPONSE_MALFORMED,
        { phase: "health", target: target.name }
      );
    }
    if (result.body.app.buildSha !== target.sourceSha) {
      throw new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.APP_SHA_MISMATCH,
        { phase: "health", target: target.name }
      );
    }
    const worker = {
      sha: result.body.worker.sha,
      imageDigest: result.body.worker.imageDigest,
    };
    if (
      sharedWorker &&
      (worker.sha !== sharedWorker.sha ||
        worker.imageDigest !== sharedWorker.imageDigest)
    ) {
      throw new TemporalProofError(
        TEMPORAL_HEALTH_CLI_REASON.WORKER_ARTIFACT_MIXED,
        { phase: "health", target: target.name }
      );
    }
    sharedWorker = worker;
    health.push({
      target: target.name,
      expectedAppSha: target.sourceSha,
      evidence: result.body,
    });
  }

  const poly = authenticated[0];
  let chat;
  try {
    chat = await runChat({
      ...options.chat,
      baseUrl: poly.baseUrl,
      apiKey: poly.apiKey,
    });
  } catch {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.CHAT_TERMINAL_MISSING,
      { phase: "chat", target: poly.name }
    );
  }
  if (
    chat?.ok !== true ||
    typeof chat.runId !== "string" ||
    !["finish", "error"].includes(chat.streamTerminal) ||
    typeof chat.runStatus !== "string"
  ) {
    throw new TemporalProofError(
      TEMPORAL_HEALTH_CLI_REASON.CHAT_TERMINAL_MISSING,
      { phase: "chat", target: poly.name }
    );
  }

  const scheduled = [];
  for (const target of authenticated) {
    try {
      const batch = await runScheduled([target], {
        ...options.scheduled,
        readLokiEvidence,
      });
      const result = batch?.[0];
      if (
        !Array.isArray(batch) ||
        batch.length !== 1 ||
        result?.target !== target.name ||
        result?.terminalStatus !== "success" ||
        result?.cleanup?.absent !== true ||
        !Number.isSafeInteger(result?.loki?.entryCount) ||
        result.loki.entryCount < 1
      ) {
        throw new TemporalProofError(
          TEMPORAL_HEALTH_CLI_REASON.RESPONSE_MALFORMED,
          { phase: "scheduled_probe", target: target.name }
        );
      }
      scheduled.push(result);
    } catch (error) {
      throw scheduledFailure(error, target.name);
    }
  }

  return {
    status: "proven",
    reason: "ok",
    health,
    chat: { target: poly.name, ...chat },
    scheduled,
  };
}
