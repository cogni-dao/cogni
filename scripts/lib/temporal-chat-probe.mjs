#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/temporal-chat-probe`
 * Purpose: Prove durable free-model chat reaches a correlated terminal run.
 * Scope: Uses public agent APIs and SSE. Does not inspect schedules or Loki.
 * Invariants: Requires queued acceptance, terminal SSE, and exact terminal run ID.
 * Side-effects: IO (optional actor registration, chat run, and run-ledger reads)
 * Links: story.5076, task.5238, task.5239
 * @public
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TERMINAL_RUN_STATUSES = new Set([
  "success",
  "error",
  "skipped",
  "cancelled",
]);

export async function runTemporalChatProbe(options, dependencies = {}) {
  const baseUrl = normalizeBaseUrl(options?.baseUrl);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? Date.now;
  const immediateFrameTimeoutMs = options?.immediateFrameTimeoutMs ?? 10_000;
  const terminalFrameTimeoutMs = options?.terminalFrameTimeoutMs ?? 120_000;
  const runVerificationTimeoutMs = options?.runVerificationTimeoutMs ?? 15_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const requestTimeoutMs = options?.requestTimeoutMs ?? 15_000;

  if (
    options?.apiKey !== undefined &&
    (typeof options.apiKey !== "string" || options.apiKey.length === 0)
  ) {
    throw new Error("apiKey must be a non-empty string");
  }
  const apiKey = options?.apiKey ?? (await registerProbeActor());

  const chatResponse = await fetchImpl(`${baseUrl}/api/v1/ai/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: "Reply with one short line confirming Temporal chat health.",
      modelRef: {
        providerKey: "platform",
        modelId: "gpt-oss-120b",
      },
      graphName: "poet",
      messageId: `probe-${randomUUID()}`,
      runId: randomUUID(),
    }),
    signal: AbortSignal.timeout(
      immediateFrameTimeoutMs + terminalFrameTimeoutMs
    ),
  });
  if (!chatResponse.ok) {
    throw new Error(
      `chat request failed (${chatResponse.status}): ${await safeResponseText(chatResponse)}`
    );
  }

  const runId = chatResponse.headers.get("x-run-id");
  if (!runId) throw new Error("chat response missing X-Run-Id");

  const stream = createSseReader(chatResponse);
  const firstFrame = await stream.nextWithin(
    immediateFrameTimeoutMs,
    "queued SSE frame"
  );
  if (
    firstFrame.type !== "data-status" ||
    firstFrame.data?.phase !== "thinking" ||
    firstFrame.data?.label !== "Queued" ||
    firstFrame.transient !== true
  ) {
    await stream.cancel();
    throw new Error(
      `first SSE frame was not queued acceptance: ${JSON.stringify(firstFrame)}`
    );
  }

  let terminalFrame;
  const terminalDeadline = now() + terminalFrameTimeoutMs;
  while (!terminalFrame) {
    const remainingMs = terminalDeadline - now();
    if (remainingMs <= 0) {
      await stream.cancel();
      throw new Error("timed out waiting for terminal SSE frame");
    }
    const frame = await stream.nextWithin(remainingMs, "terminal SSE frame");
    if (frame.type === "error") {
      await stream.cancel();
      throw new Error("chat stream ended with error");
    }
    if (frame.type === "finish") {
      terminalFrame = frame;
    }
  }
  await stream.cancel();

  const runDeadline = now() + runVerificationTimeoutMs;
  let terminalRun;
  while (!terminalRun) {
    const runs = await fetchJson(
      fetchImpl,
      `${baseUrl}/api/v1/agent/runs?limit=100`,
      { headers: { authorization: `Bearer ${apiKey}` } },
      requestTimeoutMs,
      "agent run lookup"
    );
    if (!Array.isArray(runs.runs)) {
      throw new Error("agent run lookup returned no runs array");
    }
    const exactRun = runs.runs.find((run) => run?.runId === runId);
    if (exactRun && TERMINAL_RUN_STATUSES.has(exactRun.status)) {
      if (exactRun.status !== "success") {
        throw new Error(
          `run ${runId} ended with non-success status ${exactRun.status}`
        );
      }
      terminalRun = exactRun;
      break;
    }
    if (now() >= runDeadline) {
      throw new Error(`run ${runId} was not terminal in /api/v1/agent/runs`);
    }
    await sleep(pollIntervalMs);
  }

  return {
    ok: true,
    runId,
    streamTerminal: terminalFrame.type,
    runStatus: terminalRun.status,
  };

  async function registerProbeActor() {
    const registration = await fetchJson(
      fetchImpl,
      `${baseUrl}/api/v1/agent/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `temporal-chat-probe-${now()}-${randomUUID().slice(0, 8)}`,
        }),
      },
      requestTimeoutMs,
      "agent registration"
    );
    if (typeof registration.apiKey !== "string" || registration.apiKey === "") {
      throw new Error("agent registration returned no apiKey");
    }
    return registration.apiKey;
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("baseUrl is required");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(fetchImpl, url, init, timeoutMs, label) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `${label} failed (${response.status}): ${await safeResponseText(response)}`
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function createSseReader(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("chat response has no readable SSE body");
  const decoder = new TextDecoder();
  let buffer = "";

  async function nextWithin(timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const parsed = takeSseFrame();
      if (parsed) return parsed;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        await reader.cancel();
        throw new Error(`timed out waiting for ${label}`);
      }
      let timer;
      let read;
      try {
        read = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`timed out waiting for ${label}`));
            }, remainingMs);
          }),
        ]);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (read.done) {
        throw new Error(`SSE ended before ${label}`);
      }
      buffer += decoder.decode(read.value, { stream: true });
    }
  }

  function takeSseFrame() {
    const boundary = buffer.indexOf("\n\n");
    if (boundary === -1) return undefined;
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const payload = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload || payload === "[DONE]") return takeSseFrame();
    try {
      return JSON.parse(payload);
    } catch {
      throw new Error(`invalid JSON in SSE frame: ${payload}`);
    }
  }

  return {
    nextWithin,
    cancel: async () => reader.cancel().catch(() => undefined),
  };
}

async function safeResponseText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "unreadable response";
  }
}

function defaultSleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isMainModule() {
  return (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("Usage: node scripts/lib/temporal-chat-probe.mjs <base-url>");
    process.exitCode = 2;
  } else {
    runTemporalChatProbe({ baseUrl })
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
