// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Read/validate CI release metadata and emit inputs for the existing flight writer. */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { GitHubBuildReleaseAdapter } from "../src/adapters/server/vcs/github-build-release";
import { resolveBuildRelease } from "../src/features/vcs/build-release";
import { BuildReleaseError } from "../src/ports/build-release.port";

async function main(): Promise<void> {
  const environmentSchema = z.object({
    GITHUB_REPOSITORY: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    SOURCE_SHA: z.string().regex(/^[a-fA-F0-9]{40}$/),
    RELEASE_OUTPUT_DIR: z.string().min(1),
    GITHUB_OUTPUT: z.string().min(1),
    GH_TOKEN: z.string().min(1),
    NODE_SLUG: z
      .union([z.literal(""), z.string().regex(/^[a-z0-9][a-z0-9-]*$/)])
      .optional(),
  });
  // biome-ignore lint/style/noProcessEnv: this CI entrypoint validates its complete environment at the boundary.
  const environment = environmentSchema.parse(process.env);
  const repository = environment.GITHUB_REPOSITORY;
  const sourceSha = environment.SOURCE_SHA.toLowerCase();
  const directory = environment.RELEASE_OUTPUT_DIR;
  const outputFile = environment.GITHUB_OUTPUT;
  const { release, artifact } = await resolveBuildRelease({
    repository,
    sourceSha,
    port: new GitHubBuildReleaseAdapter(environment.GH_TOKEN),
  });
  const node = environment.NODE_SLUG || undefined;
  if (node && !release.targets.some((item) => item.target === node)) {
    throw new BuildReleaseError(
      "release_invalid",
      "Requested node is absent from the complete build release; build that target first"
    );
  }
  await mkdir(directory, { recursive: true });
  const changed = join(directory, "changed-paths.txt");
  const added = join(directory, "added-paths.txt");
  const payload = join(directory, "resolved-pr-images.json");
  const releaseReceipt = join(directory, "release-receipt.json");
  await writeFile(changed, `${release.scope.changed_paths.join("\n")}\n`);
  await writeFile(added, `${release.scope.added_paths.join("\n")}\n`);
  await writeFile(
    payload,
    `${JSON.stringify(
      {
        image_name: release.image_name,
        image_tag: release.image_tag,
        source_sha: sourceSha,
        targets: release.targets.map((item) => ({
          ...item,
          source_sha: sourceSha,
        })),
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    releaseReceipt,
    `${JSON.stringify(
      {
        repository,
        sourceSha,
        artifactId: artifact.id,
        archiveDigest: artifact.digest,
        runId: artifact.runId,
      },
      null,
      2
    )}\n`
  );
  await appendFile(
    outputFile,
    Object.entries({
      changed_paths_file: changed,
      added_paths_file: added,
      base_sha: release.scope.base_sha,
      targets_json: JSON.stringify(release.scope.build_targets),
      has_targets: String(release.targets.length > 0),
      flight_targets_json: JSON.stringify(release.scope.flight_targets),
      resolved_file: payload,
      resolved_targets: release.targets.map((item) => item.target).join(","),
      has_images: String(release.targets.length > 0),
      release_artifact_id: String(artifact.id),
      release_digest: artifact.digest,
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join("")
  );
  process.stdout.write(
    `${JSON.stringify({
      event: "build_release.resolved",
      repository,
      sourceSha,
      artifactId: artifact.id,
      archiveDigest: artifact.digest,
      runId: artifact.runId,
      targets: release.scope.build_targets,
    })}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: "build_release.rejected",
      code: error instanceof BuildReleaseError ? error.code : "release_invalid",
      message:
        error instanceof Error
          ? error.message
          : "Build release resolution failed",
    })}\n`
  );
  process.exitCode = 1;
});
