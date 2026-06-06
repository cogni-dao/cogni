// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/vcs-flight-candidate`
 * Purpose: Unit tests for the core__vcs_flight_candidate tool contract + impl.
 * Scope: Tests contract shape, input validation, output validation, and implementation delegation; does not make network calls, does not spin up LangChain.
 * Invariants: NO_AUTO_FLIGHT — tool description must flag this.
 * Side-effects: none
 * Links: src/tools/vcs-flight-candidate.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import type {
  DispatchCandidateFlightResult,
  VcsCapability,
} from "../src/capabilities/vcs";
import {
  createVcsFlightCandidateImplementation,
  VCS_FLIGHT_CANDIDATE_NAME,
  vcsFlightCandidateBoundTool,
  vcsFlightCandidateContract,
} from "../src/tools/vcs-flight-candidate";

function makeVcsStub(
  dispatchImpl: VcsCapability["dispatchCandidateFlight"] = async (params) => ({
    dispatched: true,
    prNumber: params.prNumber,
    headSha: params.headSha ?? null,
    workflowUrl: `https://github.com/${params.owner}/${params.repo}/actions/workflows/candidate-flight.yml`,
    message: "ok",
  })
): VcsCapability {
  return {
    listPrs: async () => [],
    getCiStatus: async () => {
      throw new Error("not used");
    },
    mergePr: async () => {
      throw new Error("not used");
    },
    createBranch: async () => {
      throw new Error("not used");
    },
    commitExists: async () => {
      throw new Error("not used");
    },
    fetchFileText: async () => {
      throw new Error("not used");
    },
    dispatchCandidateFlight: dispatchImpl,
    dispatchNodeFlight: async () => {
      throw new Error("not used");
    },
  };
}

describe("vcs_flight_candidate contract", () => {
  it("has namespaced core__ id", () => {
    expect(vcsFlightCandidateContract.name).toBe("core__vcs_flight_candidate");
    expect(VCS_FLIGHT_CANDIDATE_NAME).toBe("core__vcs_flight_candidate");
  });

  it("is state_change effect", () => {
    expect(vcsFlightCandidateContract.effect).toBe("state_change");
  });

  it("description enforces NO_AUTO_FLIGHT via prompt", () => {
    const desc = vcsFlightCandidateContract.description.toLowerCase();
    // Both auto-flight guard and CI-prereq guard must be in the description.
    expect(desc).toContain("not auto-flight");
    expect(desc).toContain("core__vcs_get_ci_status");
  });

  it("allowlist contains public fields only", () => {
    expect(vcsFlightCandidateContract.allowlist).toEqual([
      "dispatched",
      "prNumber",
      "headSha",
      "workflowUrl",
      "message",
    ]);
  });
});

describe("vcs_flight_candidate input schema", () => {
  it("accepts prNumber only (headSha optional)", () => {
    const ok = vcsFlightCandidateContract.inputSchema.parse({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 954,
    });
    expect(ok.prNumber).toBe(954);
    expect(ok.headSha).toBeUndefined();
  });

  it("accepts 7-to-40-char hex headSha", () => {
    const short = vcsFlightCandidateContract.inputSchema.parse({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 954,
      headSha: "27379ae",
    });
    expect(short.headSha).toBe("27379ae");

    const long = vcsFlightCandidateContract.inputSchema.parse({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 954,
      headSha: "27379ae765b6834adeae9db9118a36882cd3ca93",
    });
    expect(long.headSha?.length).toBe(40);
  });

  it("rejects non-hex headSha", () => {
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "Cogni-DAO",
        repo: "node-template",
        prNumber: 954,
        headSha: "not-a-sha",
      })
    ).toThrow();
  });

  it("rejects non-positive prNumber", () => {
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "Cogni-DAO",
        repo: "node-template",
        prNumber: 0,
      })
    ).toThrow();
  });

  it("rejects empty owner or repo", () => {
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "",
        repo: "r",
        prNumber: 1,
      })
    ).toThrow();
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "o",
        repo: "",
        prNumber: 1,
      })
    ).toThrow();
  });
});

describe("vcs_flight_candidate implementation", () => {
  it("delegates to VcsCapability.dispatchCandidateFlight", async () => {
    const spy = vi.fn<
      Parameters<VcsCapability["dispatchCandidateFlight"]>,
      Promise<DispatchCandidateFlightResult>
    >(async (params) => ({
      dispatched: true,
      prNumber: params.prNumber,
      headSha: params.headSha ?? null,
      workflowUrl:
        "https://github.com/o/r/actions/workflows/candidate-flight.yml",
      message: `Flight dispatched for PR #${params.prNumber}`,
    }));

    const vcs = makeVcsStub(spy);
    const impl = createVcsFlightCandidateImplementation({ vcsCapability: vcs });

    const out = await impl.execute({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 954,
      headSha: "27379ae7",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 954,
      headSha: "27379ae7",
    });
    expect(out.dispatched).toBe(true);
    expect(out.prNumber).toBe(954);
    expect(out.headSha).toBe("27379ae7");
  });

  it("passes undefined headSha through when caller omits it", async () => {
    const spy = vi.fn<
      Parameters<VcsCapability["dispatchCandidateFlight"]>,
      Promise<DispatchCandidateFlightResult>
    >(async (params) => ({
      dispatched: true,
      prNumber: params.prNumber,
      headSha: null,
      workflowUrl:
        "https://github.com/o/r/actions/workflows/candidate-flight.yml",
      message: "ok",
    }));

    const impl = createVcsFlightCandidateImplementation({
      vcsCapability: makeVcsStub(spy),
    });

    await impl.execute({
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(spy).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: undefined,
    });
  });

  it("stub throws when capability not configured", async () => {
    await expect(
      vcsFlightCandidateBoundTool.implementation.execute({
        owner: "o",
        repo: "r",
        prNumber: 1,
      })
    ).rejects.toThrow(/VcsCapability not configured/);
  });
});

describe("vcs_flight_candidate output schema", () => {
  it("accepts valid result", () => {
    const result = vcsFlightCandidateContract.outputSchema.parse({
      dispatched: true,
      prNumber: 954,
      headSha: "27379ae7",
      workflowUrl:
        "https://github.com/Cogni-DAO/cogni/actions/workflows/candidate-flight.yml",
      message: "Flight dispatched for PR #954",
    });
    expect(result.dispatched).toBe(true);
  });

  it("accepts null headSha (no override)", () => {
    const result = vcsFlightCandidateContract.outputSchema.parse({
      dispatched: true,
      prNumber: 954,
      headSha: null,
      workflowUrl:
        "https://github.com/Cogni-DAO/cogni/actions/workflows/candidate-flight.yml",
      message: "ok",
    });
    expect(result.headSha).toBeNull();
  });

  it("rejects non-URL workflowUrl", () => {
    expect(() =>
      vcsFlightCandidateContract.outputSchema.parse({
        dispatched: true,
        prNumber: 1,
        headSha: null,
        workflowUrl: "not-a-url",
        message: "",
      })
    ).toThrow();
  });
});
