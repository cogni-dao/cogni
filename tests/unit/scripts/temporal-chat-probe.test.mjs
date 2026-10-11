// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import assert from "node:assert/strict";
import test from "node:test";

import { runTemporalChatProbe } from "../../../scripts/lib/temporal-chat-probe.mjs";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

test("proves queued-to-terminal chat and the exact terminal run", async () => {
  const calls = [];
  let runLookups = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/v1/agent/register")) {
      return jsonResponse(201, {
        userId: "agent-user",
        apiKey: "agent-secret",
        billingAccountId: "billing-agent",
      });
    }
    if (String(url).endsWith("/api/v1/ai/chat")) {
      return sseResponse(
        [
          {
            type: "data-status",
            data: { phase: "thinking", label: "Queued" },
            transient: true,
          },
          { type: "finish", finishReason: "stop" },
        ],
        RUN_ID
      );
    }
    if (String(url).includes("/api/v1/agent/runs?limit=100")) {
      runLookups += 1;
      return jsonResponse(200, {
        runs: [
          {
            runId: RUN_ID,
            status: runLookups === 1 ? "running" : "success",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await runTemporalChatProbe(
    {
      baseUrl: "https://poly.example.test/",
      pollIntervalMs: 0,
    },
    { fetchImpl, sleep: async () => undefined }
  );

  assert.deepEqual(result, {
    ok: true,
    runId: RUN_ID,
    streamTerminal: "finish",
    runStatus: "success",
  });
  assert.equal(runLookups, 2);

  const registration = calls[0];
  assert.equal(registration.init.method, "POST");
  assert.match(
    JSON.parse(registration.init.body).name,
    /^temporal-chat-probe-/
  );

  const chat = calls[1];
  assert.equal(chat.init.headers.authorization, "Bearer agent-secret");
  assert.deepEqual(JSON.parse(chat.init.body).modelRef, {
    providerKey: "platform",
    modelId: "gpt-oss-120b",
  });
  assert.equal(JSON.parse(chat.init.body).graphName, "poet");

  const lookup = calls[2];
  assert.equal(lookup.init.headers.authorization, "Bearer agent-secret");
});

test("rejects a stream whose first frame is not queued acceptance", async () => {
  const fetchImpl = sequenceFetch([
    jsonResponse(201, { apiKey: "agent-secret" }),
    sseResponse([{ type: "text-start", id: "run-1" }], RUN_ID),
  ]);

  await assert.rejects(
    runTemporalChatProbe(
      { baseUrl: "https://poly.example.test" },
      { fetchImpl }
    ),
    /first SSE frame was not queued acceptance/
  );
});

test("rejects a stream that never emits a terminal frame", async () => {
  const hangingBody = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            type: "data-status",
            data: { phase: "thinking", label: "Queued" },
            transient: true,
          })}\n\n`
        )
      );
    },
  });
  const fetchImpl = sequenceFetch([
    jsonResponse(201, { apiKey: "agent-secret" }),
    new Response(hangingBody, {
      status: 200,
      headers: { "x-run-id": RUN_ID, "content-type": "text/event-stream" },
    }),
  ]);

  await assert.rejects(
    runTemporalChatProbe(
      { baseUrl: "https://poly.example.test", terminalFrameTimeoutMs: 5 },
      { fetchImpl }
    ),
    /timed out waiting for terminal SSE frame/
  );
});

test("requires the X-Run-Id to match a terminal ledger row", async () => {
  let nowMs = 0;
  const fetchImpl = sequenceFetch([
    jsonResponse(201, { apiKey: "agent-secret" }),
    sseResponse(
      [
        {
          type: "data-status",
          data: { phase: "thinking", label: "Queued" },
          transient: true,
        },
        { type: "error", errorText: "failed" },
      ],
      RUN_ID
    ),
    jsonResponse(200, { runs: [{ runId: "another-run", status: "error" }] }),
    jsonResponse(200, { runs: [{ runId: RUN_ID, status: "running" }] }),
  ]);

  await assert.rejects(
    runTemporalChatProbe(
      {
        baseUrl: "https://poly.example.test",
        runVerificationTimeoutMs: 1,
        pollIntervalMs: 1,
      },
      {
        fetchImpl,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      }
    ),
    new RegExp(`run ${RUN_ID} was not terminal`)
  );
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames, runId) {
  const body = frames
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "x-run-id": runId, "content-type": "text/event-stream" },
  });
}

function sequenceFetch(responses) {
  let index = 0;
  return async () => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error(`unexpected fetch at index ${index - 1}`);
    return response;
  };
}
