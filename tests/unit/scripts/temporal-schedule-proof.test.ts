// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/temporal-schedule-proof`
 * Purpose: Prove the two-target CLI is fixed-order, secret-safe, and fail closed.
 * Scope: Injected dependencies only; no network, filesystem, Temporal, or Loki. Does not perform network IO or touch a real Temporal/Loki.
 * Invariants: Actor keys never appear in output; both targets reach the lifecycle harness.
 * Side-effects: none
 * Links: scripts/temporal-schedule-proof.mjs, task.5239
 * @public
 */

import { describe, expect, it, vi } from "vitest";
import {
  main,
  parseScheduleProofArgs,
} from "../../../scripts/temporal-schedule-proof.mjs";

const TARGETS = [
  {
    name: "poly",
    nodeId: "8913a24a-92f6-41e0-ab3b-ef8101298364",
    environment: "candidate-a",
    workerEnvironment: "production",
    baseUrl: "https://poly-test.cognidao.org",
  },
  {
    name: "node-template",
    nodeId: "123e4567-e89b-12d3-a456-426614174000",
    environment: "candidate-a",
    workerEnvironment: "production",
    baseUrl: "https://node-template-test.cognidao.org",
  },
];

describe("parseScheduleProofArgs", () => {
  it("defaults to candidate-a and accepts target URL overrides", () => {
    expect(
      parseScheduleProofArgs([
        "--poly-url",
        "https://poly.example",
        "--node-template-url",
        "https://template.example",
      ])
    ).toEqual({
      environment: "candidate-a",
      urls: {
        poly: "https://poly.example",
        "node-template": "https://template.example",
      },
    });
  });
});

describe("main", () => {
  it("registers both actors and runs the targets without printing keys", async () => {
    let output = "";
    const registerActor = vi.fn(async (target) => `${target.name}-secret`);
    const runTargets = vi.fn(async (targets) =>
      targets.map((target) => ({
        target: target.name,
        terminalStatus: "success",
        cleanup: { absent: true },
      }))
    );

    const exitCode = await main([], {
      targets: TARGETS,
      registerActor,
      runTargets,
      readLokiEvidence: vi.fn(),
      write: (value) => {
        output += value;
      },
    });

    expect(exitCode).toBe(0);
    expect(registerActor).toHaveBeenCalledTimes(2);
    expect(runTargets).toHaveBeenCalledWith(
      [
        expect.objectContaining({ name: "poly", apiKey: "poly-secret" }),
        expect.objectContaining({
          name: "node-template",
          apiKey: "node-template-secret",
        }),
      ],
      { readLokiEvidence: expect.any(Function) }
    );
    expect(output).toContain('"status": "proven"');
    expect(output).not.toContain("secret");
  });

  it("fails closed when either target fails", async () => {
    let output = "";
    const exitCode = await main([], {
      targets: TARGETS,
      registerActor: vi.fn(async () => "secret"),
      runTargets: vi.fn(async () => {
        throw Object.assign(new Error("no exact completion event"), {
          phase: "loki",
        });
      }),
      readLokiEvidence: vi.fn(),
      write: (value) => {
        output += value;
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toContain('"phase": "loki"');
  });
});
