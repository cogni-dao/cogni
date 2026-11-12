// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/observability/langfuse-gateway-receipt`
 * Purpose: Cross-lane generation authority from collector-labeled LiteLLM gateway receipts.
 * Scope: Fetch stubs only, no live logs or model calls.
 * Invariants: Exact lane alias + key hash + response or exact-instant failure run; fail closed.
 * Side-effects: none
 * Links: bug.5625, infra/images/litellm/cogni_callbacks.py
 * @internal
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpLangfuseGatewayReceiptVerifier } from "@/adapters/server/observability/langfuse-gateway-receipt.adapter";

const NODE = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c",
  OTHER = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  HASH = "b".repeat(64),
  RUN = "38e83ed8-0d0d-40b0-8aa8-56b457773019",
  TRACE = "b32299238d2d6ed155dba2d760e32b70",
  ALIAS = `cogni:candidate-a:${NODE}:app:v1`,
  FINGERPRINT = createHash("sha256")
    .update(`ai.gateway.receipt.v1:${HASH}`)
    .digest("hex");
const START = Date.parse("2026-11-12T20:06:15.900Z");
const iso = (t: number) => new Date(t).toISOString();

function generation(
  over: { start?: number; end?: number; id?: string; level?: string } = {}
) {
  const start = over.start ?? START;
  return {
    id: over.id ?? "2683eb1e-eb30-4de0-a6e0-fc94b11f436b",
    traceId: TRACE,
    type: "GENERATION",
    environment: "candidate-a",
    level: over.level ?? "ERROR",
    startTime: iso(start),
    endTime: iso(over.end ?? start + 690),
    output: null,
    metadata: {
      user_api_key: HASH,
      user_api_key_hash: HASH,
      user_api_key_alias: ALIAS,
      user_api_key_auth: { api_key: HASH, key_alias: ALIAS },
      requester_metadata: {
        request_id: RUN,
        existing_trace_id: TRACE,
        spend_logs_metadata: { run_id: RUN, node_id: NODE },
      },
    },
  };
}
function receipt(
  over: Record<string, unknown> & { start?: number; end?: number } = {}
) {
  const { start = START, end = start + 690, ...rest } = over;
  return {
    event: "ai.gateway.receipt",
    status: "failure",
    callId: "call-1",
    responseId: null,
    keyFingerprint: FINGERPRINT,
    keyAlias: ALIAS,
    runId: RUN,
    spendNodeId: NODE,
    startTime: iso(start),
    endTime: iso(end),
    ...rest,
  };
}
const LABELS = {
  app: "cogni-template",
  env: "candidate-a",
  service: "litellm",
  service_name: "litellm",
  node: "<no value>",
  stream: "stdout",
};
function setup(
  lines: ReadonlyArray<Record<string, unknown>>,
  labels: Record<string, string> = LABELS
) {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "streams",
            result: lines.length
              ? [
                  {
                    stream: labels,
                    values: lines.map((l, i) => [
                      String(BigInt(START + 1000 + i) * 1_000_000n),
                      JSON.stringify(l),
                    ]),
                  },
                ]
              : [],
          },
        })
      )
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    verifier: new HttpLangfuseGatewayReceiptVerifier({
      grafanaUrl: "https://grafana.example",
      token: "private-receipt-token",
      now: () => START + 3_600_000,
    }),
  };
}
const signal = () => AbortSignal.timeout(15_000);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cross-lane gateway receipts", () => {
  it("verifies each retry of one failed run by its exact instants", async () => {
    // Three attempts of one run, ~0.7s apart, as the candidate-a gateway records them.
    const starts = [START, START + 700, START + 1400];
    const lines = starts.map((start) => receipt({ start }));
    const { verifier, fetcher } = setup(lines);
    for (const start of starts) {
      expect(
        await verifier.verifyObservation(
          NODE,
          "candidate-a",
          generation({ start }),
          signal()
        )
      ).toBe(true);
    }
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    const query = url.searchParams.get("query") ?? "";
    expect(query).toContain(`{env="candidate-a",service="litellm"}`);
    expect(query).toContain(`keyFingerprint="${FINGERPRINT}"`);
    expect(query).not.toContain(HASH);
    expect(query).toContain(`runId="${RUN}"`);
    expect(BigInt(url.searchParams.get("end") ?? "0")).toBeLessThanOrEqual(
      BigInt(START + 690 + 5001) * 1_000_000n
    );
    expect(init.redirect).toBe("error");
    expect(url.toString()).not.toContain("private-receipt-token");
  });

  it("verifies a success by its provider response id", async () => {
    const row = {
      ...generation({ level: "DEFAULT", id: "time-20-06-15-900000_gen-1" }),
    };
    const { verifier, fetcher } = setup([
      receipt({ status: "success", responseId: "gen-1", runId: null }),
    ]);
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", row, signal())
    ).toBe(true);
    const [url] = fetcher.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("query")).toContain(`responseId="gen-1"`);
  });

  it.each([
    ["no receipt yet", []],
    ["two receipts at the same instant", [receipt(), receipt()]],
    ["a receipt 0.7s off", [receipt({ start: START + 700 })]],
    ["another run", [receipt({ runId: "other-run" })]],
    ["a success receipt for a failure row", [receipt({ status: "success" })]],
  ])("withholds the row for %s", async (_name, lines) => {
    const { verifier } = setup(lines);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        generation(),
        signal()
      )
    ).toBe(false);
  });

  it.each([
    [
      "a foreign alias line",
      [receipt({ keyAlias: `cogni:candidate-a:${OTHER}:app:v1` })],
    ],
    [
      "a foreign key line",
      [receipt(), receipt({ keyFingerprint: "c".repeat(64) })],
    ],
    ["a non-receipt line", [receipt(), { event: "other" }]],
  ])("fails closed on %s in the bucket", async (_name, lines) => {
    const { verifier } = setup(lines);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        generation(),
        signal()
      )
    ).toBe(false);
  });

  it.each([
    ["another lane", { ...LABELS, env: "preview" }],
    ["another service", { ...LABELS, service: "app" }],
    ["a lease push", { ...LABELS, source: "lease" }],
    ["no collector stream label", { ...LABELS, stream: "" }],
  ])("rejects receipts under %s labels", async (_name, labels) => {
    const { verifier } = setup([receipt()], labels);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        generation(),
        signal()
      )
    ).toBe(false);
  });

  it("treats a saturated bucket as a gap", async () => {
    const lines = Array.from({ length: 8 }, (_, i) =>
      receipt({ start: START + (i === 0 ? 0 : 10_000 + i * 1000) })
    );
    const { verifier } = setup(lines);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        generation(),
        signal()
      )
    ).toBe(false);
  });

  it("rejects rows that do not name the requested node and lane before IO", async () => {
    const { verifier, fetcher } = setup([receipt()]);
    const foreign = generation();
    foreign.metadata.user_api_key_alias = `cogni:candidate-a:${OTHER}:app:v1`;
    foreign.metadata.user_api_key_auth.key_alias = `cogni:candidate-a:${OTHER}:app:v1`;
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", foreign, signal())
    ).toBe(false);
    expect(
      await verifier.verifyObservation(NODE, "preview", generation(), signal())
    ).toBe(false);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        { ...generation(), type: "SPAN" },
        signal()
      )
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("types a Loki failure instead of reporting an attribution gap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate", { status: 429 }))
    );
    const verifier = new HttpLangfuseGatewayReceiptVerifier({
      grafanaUrl: "https://grafana.example",
      token: "t",
    });
    await expect(
      verifier.verifyObservation(NODE, "candidate-a", generation(), signal())
    ).rejects.toMatchObject({
      code: "observability_rate_limited",
      status: 429,
    });
  });
});
