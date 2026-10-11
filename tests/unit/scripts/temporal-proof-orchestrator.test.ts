// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/temporal-proof-orchestrator`
 * Purpose: Prove the one-command Temporal diagnostic composition and failures.
 * Scope: Uses fully mocked orchestration. Does not access network, time, or billing.
 * Invariants: One key per target, free-probe helper composition, sequential
 *   scheduled targets, stable fail-closed reasons, and secret-free output.
 * Side-effects: none
 * Links: scripts/lib/temporal-proof-orchestrator.mjs, story.5076, task.5238
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { TEMPORAL_HEALTH_CLI_REASON } from "../../../scripts/lib/temporal-health-client.mjs";
import { TemporalLokiEvidenceError } from "../../../scripts/lib/temporal-loki-evidence.mjs";
import {
  registerTemporalProbeActor,
  resolveTemporalProofTargets,
  runTemporalHealthProof,
  temporalProofFailure,
} from "../../../scripts/lib/temporal-proof-orchestrator.mjs";
import { TemporalScheduledProbeError } from "../../../scripts/lib/temporal-scheduled-probe.mjs";
import { parseTemporalHealthArgs } from "../../../scripts/temporal-health.mjs";

const TARGETS = [
  {
    name: "poly",
    nodeId: "4b06359a-a859-4399-888e-a8c7a6696f7e",
    sourceSha: "242266ad474aee590e2fbafcad08a0431d350b45",
    environment: "production",
    baseUrl: "https://poly.cognidao.org",
  },
  {
    name: "node-template",
    nodeId: "b927a9dd-6132-4fc9-a51e-e3cee2568e3c",
    sourceSha: "654e5f2132cdc774a329f24c69340170e4721d2a",
    environment: "production",
    baseUrl: "https://node-template.cognidao.org",
  },
];

function successfulDependencies() {
  const keys = {
    poly: "poly-secret-key",
    "node-template": "template-secret-key",
  } as const;
  const registerActor = vi.fn(async (target: (typeof TARGETS)[number]) => {
    return keys[target.name];
  });
  const readHealth = vi.fn(async ({ baseUrl, apiKey }) => {
    const target = baseUrl.includes("poly") ? TARGETS[0] : TARGETS[1];
    return {
      exitCode: 0,
      body: {
        status: "healthy",
        reason: "ok",
        nodeId: target.nodeId,
        app: { buildSha: target.sourceSha },
        worker: {
          sha: "c".repeat(40),
          imageDigest: `sha256:${"d".repeat(64)}`,
        },
        observedWith: apiKey === keys.poly ? "poly" : "node-template",
      },
    };
  });
  const runChat = vi.fn(async () => ({
    ok: true,
    runId: "chat-run",
    streamTerminal: "finish",
    runStatus: "success",
  }));
  const order: string[] = [];
  const runScheduled = vi.fn(async ([target], options) => {
    expect(options.readLokiEvidence).toBeTypeOf("function");
    order.push(target.name);
    return [
      {
        target: target.name,
        scheduleId: `${target.name}-schedule`,
        graphRunId: `${target.name}-run`,
        terminalStatus: "success",
        cleanup: { deleteStatus: 204, absent: true },
        loki: { entryCount: 1 },
      },
    ];
  });
  return {
    keys,
    order,
    registerActor,
    readHealth,
    runChat,
    runScheduled,
    readLokiEvidence: vi.fn(),
  };
}

describe("resolveTemporalProofTargets", () => {
  it("derives the deployed environment and exact node UUIDs from the catalog", () => {
    expect(resolveTemporalProofTargets({ repoRoot: process.cwd() })).toEqual(
      TARGETS
    );
  });

  it("fails closed when an override is not deployed by every target", () => {
    expect(() =>
      resolveTemporalProofTargets({
        repoRoot: process.cwd(),
        environment: "candidate-a",
      })
    ).toThrowError(
      expect.objectContaining({
        reason: TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
        target: "node-template",
      })
    );
  });

  it("uses explicit PR-head SHA overrides without weakening catalog defaults", () => {
    const polySha = "1".repeat(40);
    const nodeTemplateSha = "2".repeat(40);

    const targets = resolveTemporalProofTargets({
      repoRoot: process.cwd(),
      expectedShas: {
        poly: polySha,
        "node-template": nodeTemplateSha,
      },
    });

    expect(targets.map(({ name, sourceSha }) => ({ name, sourceSha }))).toEqual(
      [
        { name: "poly", sourceSha: polySha },
        { name: "node-template", sourceSha: nodeTemplateSha },
      ]
    );
    expect(resolveTemporalProofTargets({ repoRoot: process.cwd() })).toEqual(
      TARGETS
    );
  });

  it("rejects malformed expected SHA overrides", () => {
    expect(() =>
      resolveTemporalProofTargets({
        repoRoot: process.cwd(),
        expectedShas: { poly: "main" },
      })
    ).toThrowError(
      expect.objectContaining({
        reason: TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
        target: "poly",
      })
    );
  });
});

describe("parseTemporalHealthArgs", () => {
  it("accepts explicit target URLs and exact PR-head SHAs", () => {
    expect(
      parseTemporalHealthArgs([
        "--poly-url",
        "https://poly-pr.example",
        "--poly-sha",
        "a".repeat(40),
        "--node-template-url",
        "https://template-pr.example",
        "--node-template-sha",
        "b".repeat(40),
      ])
    ).toEqual({
      environment: undefined,
      urls: {
        poly: "https://poly-pr.example",
        "node-template": "https://template-pr.example",
      },
      expectedShas: {
        poly: "a".repeat(40),
        "node-template": "b".repeat(40),
      },
    });
  });
});

describe("runTemporalHealthProof", () => {
  it("preflights Loki configuration before registering remote actors", async () => {
    const registerActor = vi.fn();
    const createLokiReader = vi.fn(() => {
      throw new TemporalLokiEvidenceError("missing token", "configuration");
    });

    await expect(
      runTemporalHealthProof(
        { targets: TARGETS },
        { registerActor, createLokiReader }
      )
    ).rejects.toMatchObject({
      reason: TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
      phase: "configuration",
      target: "loki",
    });
    expect(registerActor).not.toHaveBeenCalled();
  });

  it("composes both health reads, Poly terminal chat, and both scheduled proofs", async () => {
    const dependencies = successfulDependencies();

    const result = await runTemporalHealthProof(
      { targets: TARGETS },
      dependencies
    );

    expect(result.status).toBe("proven");
    expect(dependencies.registerActor).toHaveBeenCalledTimes(2);
    expect(
      dependencies.registerActor.mock.calls.map(([target]) => target.name)
    ).toEqual(["poly", "node-template"]);
    expect(dependencies.readHealth).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ apiKey: dependencies.keys.poly })
    );
    expect(dependencies.readHealth).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ apiKey: dependencies.keys["node-template"] })
    );
    expect(dependencies.runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: TARGETS[0].baseUrl,
        apiKey: dependencies.keys.poly,
      })
    );
    expect(dependencies.runScheduled).toHaveBeenCalledTimes(2);
    expect(dependencies.runScheduled.mock.calls[0][0][0]).toMatchObject({
      name: "poly",
      apiKey: dependencies.keys.poly,
    });
    expect(dependencies.runScheduled.mock.calls[1][0][0]).toMatchObject({
      name: "node-template",
      apiKey: dependencies.keys["node-template"],
    });
    expect(dependencies.order).toEqual(["poly", "node-template"]);
    expect(result.scheduled.map((entry) => entry.target)).toEqual([
      "poly",
      "node-template",
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(dependencies.keys.poly);
    expect(serialized).not.toContain(dependencies.keys["node-template"]);
  });

  it("stops before graph probes when a server-observed health check fails", async () => {
    const dependencies = successfulDependencies();
    dependencies.readHealth.mockResolvedValueOnce({
      exitCode: 1,
      body: { status: "unhealthy", reason: "workflow_poller_stale" },
    });

    await expect(
      runTemporalHealthProof({ targets: TARGETS }, dependencies)
    ).rejects.toMatchObject({
      reason: "workflow_poller_stale",
      phase: "health",
      target: "poly",
    });
    expect(dependencies.runChat).not.toHaveBeenCalled();
    expect(dependencies.runScheduled).not.toHaveBeenCalled();
  });

  it("fails when a healthy route serves a different app SHA than the catalog", async () => {
    const dependencies = successfulDependencies();
    dependencies.readHealth.mockResolvedValueOnce({
      exitCode: 0,
      body: {
        status: "healthy",
        reason: "ok",
        nodeId: TARGETS[0].nodeId,
        app: { buildSha: "f".repeat(40) },
        worker: {
          sha: "c".repeat(40),
          imageDigest: `sha256:${"d".repeat(64)}`,
        },
      },
    });

    await expect(
      runTemporalHealthProof({ targets: TARGETS }, dependencies)
    ).rejects.toMatchObject({
      reason: TEMPORAL_HEALTH_CLI_REASON.APP_SHA_MISMATCH,
      target: "poly",
    });
  });

  it("fails when nodes report mixed shared-worker artifacts", async () => {
    const dependencies = successfulDependencies();
    dependencies.readHealth.mockResolvedValueOnce({
      exitCode: 0,
      body: {
        status: "healthy",
        reason: "ok",
        nodeId: TARGETS[0].nodeId,
        app: { buildSha: TARGETS[0].sourceSha },
        worker: {
          sha: "c".repeat(40),
          imageDigest: `sha256:${"d".repeat(64)}`,
        },
      },
    });
    dependencies.readHealth.mockResolvedValueOnce({
      exitCode: 0,
      body: {
        status: "healthy",
        reason: "ok",
        nodeId: TARGETS[1].nodeId,
        app: { buildSha: TARGETS[1].sourceSha },
        worker: {
          sha: "e".repeat(40),
          imageDigest: `sha256:${"d".repeat(64)}`,
        },
      },
    });

    await expect(
      runTemporalHealthProof({ targets: TARGETS }, dependencies)
    ).rejects.toMatchObject({
      reason: TEMPORAL_HEALTH_CLI_REASON.WORKER_ARTIFACT_MIXED,
      target: "node-template",
    });
  });

  it.each([
    [
      new TemporalScheduledProbeError("create failed", {
        phase: "create_schedule",
      }),
      TEMPORAL_HEALTH_CLI_REASON.SCHEDULE_DRIFT,
    ],
    [
      new TemporalScheduledProbeError("no run", {
        phase: "wait_run",
        evidence: { graphRunId: null },
      }),
      TEMPORAL_HEALTH_CLI_REASON.RECENT_TERMINAL_MISSING,
    ],
    [
      new TemporalScheduledProbeError("still running", {
        phase: "wait_run",
        evidence: { graphRunId: "run-1" },
      }),
      TEMPORAL_HEALTH_CLI_REASON.EXECUTION_STALE,
    ],
  ])("maps scheduled failure %# to %s", async (scheduledError, reason) => {
    const dependencies = successfulDependencies();
    dependencies.runScheduled.mockRejectedValueOnce(scheduledError);

    await expect(
      runTemporalHealthProof({ targets: TARGETS }, dependencies)
    ).rejects.toMatchObject({ reason, target: "poly" });
  });
});

describe("registration and terminal failure output", () => {
  it("registers one named actor without leaking an error response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ apiKey: "must-not-leak" }), {
        status: 500,
      })
    );

    let failure: ReturnType<typeof temporalProofFailure> | undefined;
    try {
      await registerTemporalProbeActor(
        TARGETS[0],
        {},
        { fetchImpl, now: () => 123, nonce: () => "fixed" }
      );
    } catch (error) {
      failure = temporalProofFailure(error);
    }

    expect(failure).toEqual({
      status: "error",
      reason: TEMPORAL_HEALTH_CLI_REASON.REGISTRATION_FAILED,
      phase: "registration",
      target: "poly",
    });
    expect(JSON.stringify(failure)).not.toContain("must-not-leak");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      name: "temporal-health-poly-123-fixed",
    });
  });
});
