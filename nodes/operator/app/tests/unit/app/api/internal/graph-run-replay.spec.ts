// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/internal/graph-run-replay.spec`
 * Purpose: Pin VERDICT_SURVIVES_REPLAY (story.5102): a finalized execution request replays its
 *   structured output on the cached branches, and the persisted output is bounded to 64 KB.
 * Scope: Pure helpers exported by the internal graph run route. Does not test HTTP or DB paths
 *   (the stack test covers the DB round trip).
 * Invariants: Cached ok replay carries structuredOutput; failures never do; >64 KB → null.
 * Side-effects: none
 * Links: src/app/api/internal/graphs/[graphId]/runs/route.ts, story.5102
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  boundStructuredOutput,
  cachedRunResponse,
  MAX_STRUCTURED_OUTPUT_BYTES,
} from "@/app/api/internal/graphs/[graphId]/runs/route";

const verdict = {
  metrics: [{ metric: "m", value: 0.2, observations: ["x"], citations: ["r"] }],
  summary: "s",
  evidence: { files: ["a.ts"], entries: ["r"] },
  uncited: false,
};

describe("cachedRunResponse (VERDICT_SURVIVES_REPLAY)", () => {
  it("returns the persisted structured output on a cached success", () => {
    expect(
      cachedRunResponse({
        runId: "run-1",
        traceId: "t",
        ok: true,
        errorCode: null,
        structuredOutput: verdict,
      })
    ).toEqual({
      ok: true,
      runId: "run-1",
      traceId: "t",
      structuredOutput: verdict,
    });
  });

  it("omits structured output when none was persisted, and on failures", () => {
    expect(
      cachedRunResponse({
        runId: "run-2",
        traceId: null,
        ok: true,
        errorCode: null,
        structuredOutput: null,
      })
    ).toEqual({ ok: true, runId: "run-2", traceId: null });
    expect(
      cachedRunResponse({
        runId: "run-3",
        traceId: null,
        ok: false,
        errorCode: "insufficient_credits",
        structuredOutput: verdict,
      })
    ).toEqual({
      ok: false,
      runId: "run-3",
      traceId: null,
      error: "insufficient_credits",
    });
  });
});

describe("boundStructuredOutput", () => {
  it("keeps a plain object within the bound", () => {
    expect(boundStructuredOutput(verdict)).toBe(verdict);
  });

  it("drops absent, non-object and oversized outputs", () => {
    expect(boundStructuredOutput(undefined)).toBeNull();
    expect(boundStructuredOutput("text")).toBeNull();
    expect(boundStructuredOutput([1, 2])).toBeNull();
    const big = { blob: "x".repeat(MAX_STRUCTURED_OUTPUT_BYTES) };
    expect(boundStructuredOutput(big)).toBeNull();
  });
});
