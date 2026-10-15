// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubBuildReleaseAdapter } from "./github-build-release";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@octokit/core", () => ({
  Octokit: class {
    request = request;
  },
}));

const input = { repository: "cogni-dao/cogni", sourceSha: "a".repeat(40) };

function listed() {
  return {
    total_count: 1,
    artifacts: [
      {
        id: 1,
        name: `build-manifest-${input.sourceSha}`,
        expired: false,
        digest: `sha256:${"b".repeat(64)}`,
        size_in_bytes: 3,
        workflow_run: { id: 2 },
      },
    ],
  };
}

function producer() {
  return {
    id: 2,
    workflow_id: 3,
    path: ".github/workflows/pr-build.yml",
    head_sha: input.sourceSha,
    head_branch: "feature",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    repository: { full_name: input.repository },
    head_repository: { full_name: input.repository },
  };
}

describe("GitHub build release carrier", () => {
  beforeEach(() => {
    request.mockReset();
  });

  function mockCarrier(artifacts = listed(), run = producer()) {
    request.mockImplementation(async (route: string) => {
      if (route.includes("/actions/workflows/")) return { data: { id: 3 } };
      if (route.endsWith("/actions/artifacts")) return { data: artifacts };
      if (route.includes("/actions/runs/")) return { data: run };
      if (
        route.includes("/archive_format") ||
        route.includes("{archive_format}")
      )
        return { data: new Uint8Array([1, 2, 3]).buffer };
      throw new Error("Unexpected API route");
    });
  }

  it("rejects archive bytes with the wrong digest before extracting a payload", async () => {
    mockCarrier();
    await expect(
      new GitHubBuildReleaseAdapter("fixture").readArtifacts(input)
    ).rejects.toMatchObject({ code: "release_integrity" });
  });

  it("ignores expired artifacts and unsuccessful producers", async () => {
    const artifacts = listed();
    for (const item of artifacts.artifacts) item.expired = true;
    mockCarrier(artifacts);
    await expect(
      new GitHubBuildReleaseAdapter("fixture").readArtifacts(input)
    ).resolves.toEqual([]);
    mockCarrier(listed(), { ...producer(), conclusion: "failure" });
    await expect(
      new GitHubBuildReleaseAdapter("fixture").readArtifacts(input)
    ).resolves.toEqual([]);
  });

  it("rejects artifacts produced by another workflow", async () => {
    mockCarrier(listed(), { ...producer(), workflow_id: 999 });
    await expect(
      new GitHubBuildReleaseAdapter("fixture").readArtifacts(input)
    ).rejects.toMatchObject({ code: "release_provenance" });
    expect(
      request.mock.calls.some(([route]) =>
        String(route).includes("{archive_format}")
      )
    ).toBe(false);
  });

  it("bounds artifact count and size before downloading", async () => {
    mockCarrier({ ...listed(), total_count: 101 });
    await expect(
      new GitHubBuildReleaseAdapter("fixture").readArtifacts(input)
    ).rejects.toMatchObject({ code: "release_unavailable" });
    const artifacts = listed();
    for (const item of artifacts.artifacts)
      item.size_in_bytes = 3 * 1024 * 1024;
    mockCarrier(artifacts);
    await expect(
      new GitHubBuildReleaseAdapter("fixture").readArtifacts(input)
    ).rejects.toMatchObject({ code: "release_unavailable" });
  });

  it("returns a bounded provider failure without exposing credential-bearing exceptions", async () => {
    request.mockRejectedValue(new Error("sensitive provider context"));
    await expect(
      new GitHubBuildReleaseAdapter("fixture").readArtifacts(input)
    ).rejects.toThrow("Unable to read/validate bounded CI release artifacts");
  });
});
