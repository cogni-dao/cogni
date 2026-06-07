// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/vcs-flight-candidate`
 * Purpose: Unit tests for the core__vcs_flight_candidate tool contract + impl.
 * Scope: Tests contract shape, input validation, output validation, and implementation delegation; does not dispatch workflows.
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

const SOURCE_SHA = "0123456789012345678901234567890123456789";

function makeVcsStub(
  dispatchImpl: VcsCapability["dispatchCandidateFlight"] = async (params) => ({
    dispatched: true,
    nodeSlug: params.nodeSlug,
    sourceSha: params.sourceSha,
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
    dispatchCandidateFlight: dispatchImpl,
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

  it("description rejects automatic PR-shaped artifact identity", () => {
    const desc = vcsFlightCandidateContract.description.toLowerCase();
    expect(desc).toContain("not auto-flight");
    expect(desc).toContain("source");
    expect(desc).toContain("do not use pr numbers");
  });

  it("allowlist contains public nodeRef fields only", () => {
    expect(vcsFlightCandidateContract.allowlist).toEqual([
      "dispatched",
      "nodeSlug",
      "sourceSha",
      "workflowUrl",
      "message",
    ]);
  });
});

describe("vcs_flight_candidate input schema", () => {
  it("accepts node slug and 40-char sourceSha", () => {
    const ok = vcsFlightCandidateContract.inputSchema.parse({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "creative",
      sourceSha: SOURCE_SHA,
    });
    expect(ok.nodeSlug).toBe("creative");
    expect(ok.sourceSha).toBe(SOURCE_SHA);
  });

  it("rejects PR-shaped and non-SHA inputs", () => {
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "Cogni-DAO",
        repo: "cogni",
        prNumber: 954,
      })
    ).toThrow();
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "Cogni-DAO",
        repo: "cogni",
        nodeSlug: "creative",
        sourceSha: "27379ae",
      })
    ).toThrow();
  });

  it("rejects empty owner, repo, or invalid node slug", () => {
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "",
        repo: "r",
        nodeSlug: "creative",
        sourceSha: SOURCE_SHA,
      })
    ).toThrow();
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "o",
        repo: "",
        nodeSlug: "creative",
        sourceSha: SOURCE_SHA,
      })
    ).toThrow();
    expect(() =>
      vcsFlightCandidateContract.inputSchema.parse({
        owner: "o",
        repo: "r",
        nodeSlug: "Creative",
        sourceSha: SOURCE_SHA,
      })
    ).toThrow();
  });
});

describe("vcs_flight_candidate implementation", () => {
  it("delegates nodeRef dispatch to VcsCapability.dispatchCandidateFlight", async () => {
    const spy = vi.fn<
      Parameters<VcsCapability["dispatchCandidateFlight"]>,
      Promise<DispatchCandidateFlightResult>
    >(async (params) => ({
      dispatched: true,
      nodeSlug: params.nodeSlug,
      sourceSha: params.sourceSha,
      workflowUrl:
        "https://github.com/o/r/actions/workflows/candidate-flight.yml",
      message: `Candidate flight dispatched for ${params.nodeSlug}`,
    }));

    const impl = createVcsFlightCandidateImplementation({
      vcsCapability: makeVcsStub(spy),
    });

    const out = await impl.execute({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "creative",
      sourceSha: SOURCE_SHA,
    });

    expect(spy).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      nodeSlug: "creative",
      sourceSha: SOURCE_SHA,
      workflowRef: undefined,
    });
    expect(out.dispatched).toBe(true);
    expect(out.nodeSlug).toBe("creative");
    expect(out.sourceSha).toBe(SOURCE_SHA);
  });

  it("stub throws when capability not configured", async () => {
    await expect(
      vcsFlightCandidateBoundTool.implementation.execute({
        owner: "o",
        repo: "r",
        nodeSlug: "creative",
        sourceSha: SOURCE_SHA,
      })
    ).rejects.toThrow(/VcsCapability not configured/);
  });
});

describe("vcs_flight_candidate output schema", () => {
  it("accepts valid result", () => {
    const result = vcsFlightCandidateContract.outputSchema.parse({
      dispatched: true,
      nodeSlug: "creative",
      sourceSha: SOURCE_SHA,
      workflowUrl:
        "https://github.com/Cogni-DAO/cogni/actions/workflows/candidate-flight.yml",
      message: "Candidate flight dispatched for creative",
    });
    expect(result.sourceSha).toBe(SOURCE_SHA);
  });

  it("rejects non-URL workflowUrl", () => {
    expect(() =>
      vcsFlightCandidateContract.outputSchema.parse({
        dispatched: true,
        nodeSlug: "creative",
        sourceSha: SOURCE_SHA,
        workflowUrl: "not-a-url",
        message: "",
      })
    ).toThrow();
  });
});
