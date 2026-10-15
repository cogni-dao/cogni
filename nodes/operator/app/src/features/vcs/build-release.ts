// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** SHA-addressed build scope and pinned artifacts; PR identity is optional provenance. */
import { z } from "zod";

import type { BuildReleaseArtifact, BuildReleasePort } from "@/ports";
import { BuildReleaseError } from "@/shared/vcs/build-release-error";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const target = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const paths = z
  .array(
    z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.split("/").includes("..") &&
          !/[\r\n\0]/.test(value)
      )
  )
  .max(20000);

export const buildReleaseSchema = z.object({
  schema_version: z.literal(2),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  head_sha: sha,
  image_name: z.string().min(1),
  image_tag: z.string().min(1),
  scope: z.object({
    base_sha: sha,
    changed_paths: paths,
    added_paths: paths,
    build_targets: z.array(target).max(200),
    flight_targets: z.array(target).max(200),
  }),
  targets: z
    .array(
      z.object({
        target,
        tag: z.string().regex(/^ghcr\.io\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+$/),
        digest: z
          .string()
          .regex(/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/),
      })
    )
    .max(200),
});

export type BuildRelease = z.infer<typeof buildReleaseSchema>;

export function validateBuildRelease(
  payload: unknown,
  input: {
    readonly repository: string;
    readonly sourceSha: string;
    readonly nonFlightTargets?: readonly string[];
  }
): BuildRelease {
  const result = buildReleaseSchema.safeParse(payload);
  if (!result.success) {
    throw new BuildReleaseError(
      "release_invalid",
      "Build release v2 is missing or invalid; rerun PR Build for this SHA"
    );
  }
  const release = result.data;
  if (
    release.repository.toLowerCase() !== input.repository.toLowerCase() ||
    release.head_sha !== input.sourceSha.toLowerCase() ||
    release.image_tag !== `sha-${release.head_sha}`
  ) {
    throw new BuildReleaseError(
      "release_invalid",
      "Build release repository/SHA does not match the requested source"
    );
  }
  const built = release.targets.map((item) => item.target);
  const expected = release.scope.build_targets;
  const expectedFlight = built.filter(
    (item) => !(input.nonFlightTargets ?? []).includes(item)
  );
  if (
    new Set(built).size !== built.length ||
    new Set(expected).size !== expected.length ||
    built.length !== expected.length ||
    expected.some((item) => !built.includes(item)) ||
    new Set(release.scope.flight_targets).size !==
      release.scope.flight_targets.length ||
    release.scope.flight_targets.some((item) => !built.includes(item)) ||
    expectedFlight.length !== release.scope.flight_targets.length ||
    expectedFlight.some(
      (item) => !release.scope.flight_targets.includes(item)
    ) ||
    release.scope.added_paths.some(
      (item) => !release.scope.changed_paths.includes(item)
    )
  ) {
    throw new BuildReleaseError(
      "release_invalid",
      "Build release has an incomplete or contradictory affected target scope"
    );
  }
  const namespace = `ghcr.io/${input.repository.slice(0, input.repository.indexOf("/")).toLowerCase()}/`;
  for (const item of release.targets) {
    if (
      !item.tag.startsWith(namespace) ||
      item.tag.split(":")[0] !== item.digest.split("@")[0]
    ) {
      throw new BuildReleaseError(
        "release_invalid",
        "Build release image repository does not match its pinned digest/source namespace"
      );
    }
  }
  return release;
}

function verifyProducer(
  artifact: BuildReleaseArtifact,
  repository: string,
  sourceSha: string
): void {
  const sameRepo = (value: string) =>
    value.toLowerCase() === repository.toLowerCase();
  if (
    artifact.name !== `build-manifest-${sourceSha}` ||
    !sameRepo(artifact.repository) ||
    !sameRepo(artifact.headRepository) ||
    artifact.workflowPath !== ".github/workflows/pr-build.yml" ||
    !["pull_request", "push", "merge_group", "workflow_dispatch"].includes(
      artifact.event
    ) ||
    (artifact.event === "workflow_dispatch"
      ? artifact.headBranch !== "main"
      : artifact.sourceSha !== sourceSha)
  ) {
    throw new BuildReleaseError(
      "release_provenance",
      "Build release was not produced by the expected repository/workflow/source"
    );
  }
}

function releaseIdentity(release: BuildRelease): string {
  return JSON.stringify({
    ...release,
    repository: release.repository.toLowerCase(),
    scope: {
      ...release.scope,
      changed_paths: [...new Set(release.scope.changed_paths)].sort(),
      added_paths: [...new Set(release.scope.added_paths)].sort(),
      build_targets: [...release.scope.build_targets].sort(),
      flight_targets: [...release.scope.flight_targets].sort(),
    },
    targets: [...release.targets].sort((a, b) =>
      a.target.localeCompare(b.target)
    ),
  });
}

export async function resolveBuildRelease(input: {
  readonly repository: string;
  readonly sourceSha: string;
  readonly port: BuildReleasePort;
  readonly nonFlightTargets?: readonly string[];
}): Promise<{
  readonly release: BuildRelease;
  readonly artifact: BuildReleaseArtifact;
}> {
  const sourceSha = sha.parse(input.sourceSha.toLowerCase());
  const artifacts = await input.port.readArtifacts({
    repository: input.repository,
    sourceSha,
  });
  if (artifacts.length === 0) {
    throw new BuildReleaseError(
      "release_missing",
      "No successful unexpired build release exists; rerun PR Build for this SHA"
    );
  }
  for (const artifact of artifacts)
    verifyProducer(artifact, input.repository, sourceSha);
  const current = artifacts.filter(
    (artifact) =>
      !z.object({ schema_version: z.literal(1) }).safeParse(artifact.payload)
        .success
  );
  if (current.length === 0) {
    throw new BuildReleaseError(
      "release_invalid",
      "Only legacy build records exist; rebuild this SHA using the release v2 producer"
    );
  }
  const releases = current.map((artifact) => {
    return {
      artifact,
      release: validateBuildRelease(artifact.payload, {
        repository: input.repository,
        sourceSha,
        nonFlightTargets: input.nonFlightTargets ?? [],
      }),
    };
  });
  const selected = releases.sort((a, b) => b.artifact.id - a.artifact.id)[0];
  if (!selected) {
    throw new BuildReleaseError(
      "release_missing",
      "No build release was selected"
    );
  }
  const identity = releaseIdentity(selected.release);
  if (releases.some(({ release }) => releaseIdentity(release) !== identity)) {
    throw new BuildReleaseError(
      "release_conflict",
      "Successful builds disagree on this SHA's release scope/digests; select a new source revision"
    );
  }
  return selected;
}
