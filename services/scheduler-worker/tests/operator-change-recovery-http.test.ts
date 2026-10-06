// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/operator-change-recovery-http.test`
 * Purpose: Pin the recovery HTTP adapter's target, auth, idempotency, and retry classification.
 * Scope: Fetch-stubbed unit tests only. Does not call a live operator, GitHub, or Temporal.
 * Invariants:
 *   - Only strict HTTP 200 results are semantic completion.
 *   - 408, 429, 5xx, network, and ambiguous success responses are retryable.
 *   - Permanent 4xx responses are non-retryable and no GitHub credential is required.
 * Side-effects: temporarily stubs global fetch
 * Links: task.5188, services/scheduler-worker/src/adapters/operator-change-recovery-http.ts
 * @internal
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperatorChangeRecoveryHttpClient,
} from "../src/adapters/operator-change-recovery-http.js";
import { RunHttpClientError } from "../src/ports/index.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Parameters<
  typeof createOperatorChangeRecoveryHttpClient
>[0]["logger"];

const request = {
  owner: "cogni-test-org",
  repo: "cogni-monorepo",
  prNumber: 68,
  signedBaseSha: "a".repeat(40),
  losingHeadSha: "b".repeat(40),
  intent: {
    operation: "env.placement" as const,
    node: "red",
    recoveryRootSha: "b".repeat(40),
    recoveryDepth: 0,
    environment: "candidate-a" as const,
    provider: "akash" as const,
  },
};

function client() {
  return createOperatorChangeRecoveryHttpClient({
    nodeEndpoints: new Map([
      ["operator", "https://operator.internal.example/"],
    ]),
    schedulerApiToken: "scheduler-token-not-a-github-credential",
    logger,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("operator-change recovery HTTP adapter", () => {
  it("returns a strict semantic 200 and forwards stable internal auth headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "satisfied",
          reason: "main_equals_losing_head",
          mainSha: request.losingHeadSha,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      client().recover(request, "cogni-test-org/cogni-monorepo/head")
    ).resolves.toEqual({
      status: "satisfied",
      reason: "main_equals_losing_head",
      mainSha: request.losingHeadSha,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(url).toBe(
      "https://operator.internal.example/api/internal/operator-change/recover"
    );
    expect(init?.method).toBe("POST");
    expect(headers.get("authorization")).toBe(
      "Bearer scheduler-token-not-a-github-credential"
    );
    expect(headers.get("idempotency-key")).toBe(
      "cogni-test-org/cogni-monorepo/head"
    );
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it.each([408, 429, 500, 503])(
    "classifies HTTP %s as retryable",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("temporary", { status })
      );
      const error = await client()
        .recover(request, "stable-key")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RunHttpClientError);
      expect((error as RunHttpClientError).retryable).toBe(true);
      expect((error as RunHttpClientError).status).toBe(status);
    }
  );

  it.each([400, 401, 403, 404, 409, 422])(
    "classifies permanent HTTP %s as non-retryable",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("permanent", { status })
      );
      const error = await client()
        .recover(request, "stable-key")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RunHttpClientError);
      expect((error as RunHttpClientError).retryable).toBe(false);
      expect((error as RunHttpClientError).status).toBe(status);
    }
  );

  it("classifies a network failure as retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    const error = await client()
      .recover(request, "stable-key")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunHttpClientError);
    expect((error as RunHttpClientError).retryable).toBe(true);
    expect((error as RunHttpClientError).status).toBe(0);
  });

  it("treats malformed HTTP 200 as retryable because the write is ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "landed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const error = await client()
      .recover(request, "stable-key")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunHttpClientError);
    expect((error as RunHttpClientError).retryable).toBe(true);
    expect((error as RunHttpClientError).status).toBe(200);
  });

  it("fails closed when the operator endpoint is absent", async () => {
    const absent = createOperatorChangeRecoveryHttpClient({
      nodeEndpoints: new Map(),
      schedulerApiToken: "scheduler-token",
      logger,
    });
    const error = await absent
      .recover(request, "stable-key")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunHttpClientError);
    expect((error as RunHttpClientError).retryable).toBe(false);
  });
});
