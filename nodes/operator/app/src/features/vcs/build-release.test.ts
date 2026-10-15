// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import type { BuildReleaseArtifact, BuildReleasePort } from "@/ports";
import {
  type BuildRelease,
  resolveBuildRelease,
  validateBuildRelease,
} from "./build-release";

const repository = "cogni-dao/cogni";
const sourceSha = "9f60e69c7b85db1bbb51b658f31dcacbfbc89117";
const digest = `sha256:${"a".repeat(64)}`;
const context = { repository, sourceSha };

type ReleaseImage = BuildRelease["targets"][number];

function release(): BuildRelease & { targets: [ReleaseImage, ReleaseImage] } {
  const image = (target: string): ReleaseImage => ({
    target,
    tag: `ghcr.io/cogni-dao/cogni-template:sha-${sourceSha}${target === "operator" ? "" : `-${target}`}`,
    digest: `ghcr.io/cogni-dao/cogni-template@${digest}`,
  });
  return {
    schema_version: 2,
    repository,
    head_sha: sourceSha,
    image_name: "ghcr.io/cogni-dao/cogni-template",
    image_tag: `sha-${sourceSha}`,
    scope: {
      base_sha: "b".repeat(40),
      changed_paths: [
        "nodes/operator/app/src/route.ts",
        "services/scheduler-worker/src/worker.ts",
      ],
      added_paths: ["nodes/operator/app/src/route.ts"],
      build_targets: ["operator", "scheduler-worker"],
      flight_targets: ["operator", "scheduler-worker"],
    },
    targets: [image("operator"), image("scheduler-worker")],
  };
}

function artifact(payload: unknown = release(), id = 1): BuildReleaseArtifact {
  return {
    id,
    digest,
    name: `build-manifest-${sourceSha}`,
    runId: 123,
    repository,
    headRepository: repository,
    sourceSha,
    workflowPath: ".github/workflows/pr-build.yml",
    event: "pull_request",
    headBranch: "feature",
    payload,
  };
}

function resolve(artifacts: readonly BuildReleaseArtifact[]) {
  const port: BuildReleasePort = { readArtifacts: async () => artifacts };
  return resolveBuildRelease({ ...context, port });
}

describe("SHA build releases", () => {
  it("excludes only catalog-declared infra from the required app flight closure", () => {
    const payload = release();
    payload.targets[1].target = "litellm";
    payload.scope.build_targets = ["operator", "litellm"];
    payload.scope.flight_targets = ["operator"];
    expect(
      validateBuildRelease(payload, {
        ...context,
        nonFlightTargets: ["litellm"],
      })
    ).toBeDefined();
    expect(() => validateBuildRelease(payload, context)).toThrow();
  });
  it("carries the complete worker and app scope with pinned digests without a PR dependency", async () => {
    const result = await resolve([artifact()]);
    expect(result.release.scope.flight_targets).toEqual([
      "operator",
      "scheduler-worker",
    ]);
    expect(result.release.targets.map((item) => item.digest)).toEqual([
      `ghcr.io/cogni-dao/cogni-template@${digest}`,
      `ghcr.io/cogni-dao/cogni-template@${digest}`,
    ]);
    expect(result.artifact.id).toBe(1);
  });

  it("accepts compatible builds regardless of PR metadata, target order, or record count", async () => {
    const second = {
      ...release(),
      pr_number: 2748,
      created_at: "later",
      targets: [...release().targets].reverse(),
      scope: {
        ...release().scope,
        build_targets: ["scheduler-worker", "operator"],
        flight_targets: ["scheduler-worker", "operator"],
      },
    };
    const result = await resolve([
      artifact({ ...release(), pr_number: 2745 }),
      artifact(second, 2),
    ]);
    expect(result.artifact.id).toBe(2);
  });

  it("rejects contradictory releases instead of choosing an arbitrary build", async () => {
    const second = release();
    second.targets[1].digest = `ghcr.io/cogni-dao/cogni-template@sha256:${"c".repeat(64)}`;
    await expect(
      resolve([artifact(), artifact(second, 2)])
    ).rejects.toMatchObject({ code: "release_conflict" });
  });

  it("rejects conflicting build-time scope for the same source", async () => {
    const second = release();
    second.scope.base_sha = "c".repeat(40);
    await expect(
      resolve([artifact(), artifact(second, 2)])
    ).rejects.toMatchObject({ code: "release_conflict" });
  });

  it("requires a fresh build for missing/expired or legacy records", async () => {
    await expect(resolve([])).rejects.toMatchObject({
      code: "release_missing",
    });
    await expect(
      resolve([artifact({ ...release(), schema_version: 1 })])
    ).rejects.toMatchObject({ code: "release_invalid" });
  });

  it("uses a v2 rebuild while a legacy artifact remains within retention", async () => {
    const result = await resolve([
      artifact({ ...release(), schema_version: 1 }),
      artifact(release(), 2),
    ]);
    expect(result.artifact.id).toBe(2);
  });

  it.each([
    { headRepository: "attacker/cogni" },
    { repository: "attacker/cogni" },
    { sourceSha: "c".repeat(40) },
    { workflowPath: ".github/workflows/other.yml" },
    { event: "pull_request_target" },
    { name: "build-manifest-other" },
  ])("rejects an incorrectly bound producer: %j", async (override) => {
    await expect(
      resolve([{ ...artifact(), ...override }])
    ).rejects.toMatchObject({ code: "release_provenance" });
  });

  it("accepts operator-dispatched builds on trusted main while checking payload source", async () => {
    await expect(
      resolve([
        {
          ...artifact(),
          event: "workflow_dispatch",
          headBranch: "main",
          sourceSha: "c".repeat(40),
        },
      ])
    ).resolves.toMatchObject({ release: { head_sha: sourceSha } });
    await expect(
      resolve([
        { ...artifact(), event: "workflow_dispatch", headBranch: "feature" },
      ])
    ).rejects.toMatchObject({ code: "release_provenance" });
  });

  it("normalizes SHA casing at the address boundary", async () => {
    const port: BuildReleasePort = {
      readArtifacts: async (input) => {
        expect(input.sourceSha).toBe(sourceSha);
        return [artifact()];
      },
    };
    await expect(
      resolveBuildRelease({
        repository,
        sourceSha: sourceSha.toUpperCase(),
        port,
      })
    ).resolves.toBeDefined();
  });

  it.each([
    "missing-worker",
    "duplicate",
    "extra-target",
    "mutable-digest",
    "foreign-image",
    "wrong-repository",
    "wrong-sha",
    "foreign-flight",
    "omitted-worker-flight",
    "unrecorded-addition",
    "unsafe-path",
  ])("rejects an invalid sealed release: %s", (kind) => {
    const payload = release();
    if (kind === "missing-worker") payload.targets.pop();
    if (kind === "duplicate") payload.targets.push(payload.targets[0]);
    if (kind === "extra-target") payload.scope.build_targets.push("extra");
    if (kind === "mutable-digest")
      payload.targets[0].digest = "ghcr.io/cogni-dao/cogni-template:latest";
    if (kind === "foreign-image")
      payload.targets[0].digest = `ghcr.io/attacker/image@${digest}`;
    if (kind === "wrong-repository") payload.repository = "attacker/cogni";
    if (kind === "wrong-sha") payload.head_sha = "c".repeat(40);
    if (kind === "foreign-flight") payload.scope.flight_targets.push("foreign");
    if (kind === "omitted-worker-flight") payload.scope.flight_targets.pop();
    if (kind === "unrecorded-addition")
      payload.scope.added_paths.push("missing.ts");
    if (kind === "unsafe-path") payload.scope.changed_paths.push("../escape");
    expect(() => validateBuildRelease(payload, context)).toThrow();
  });
});
