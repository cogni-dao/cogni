// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Read-only GitHub Actions carrier for immutable SHA-addressed build releases. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Octokit } from "@octokit/core";
import { z } from "zod";

import {
  type BuildReleaseArtifact,
  BuildReleaseError,
  type BuildReleasePort,
} from "@/ports";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;
const artifactListSchema = z.object({
  total_count: z.number().int().nonnegative().max(8),
  artifacts: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string(),
        expired: z.boolean(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        size_in_bytes: z.number().int().nonnegative().max(MAX_BYTES),
        workflow_run: z.object({ id: z.number().int().positive() }),
      })
    )
    .max(8),
});
const runSchema = z.object({
  id: z.number().int().positive(),
  workflow_id: z.number().int().positive(),
  path: z.string(),
  head_sha: z.string(),
  head_branch: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  repository: z.object({ full_name: z.string() }),
  head_repository: z.object({ full_name: z.string() }),
});

export class GitHubBuildReleaseAdapter implements BuildReleasePort {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
      request: {
        timeout: 20000,
        headers: { "X-GitHub-Api-Version": "2022-11-28" },
      },
    });
  }

  async readArtifacts(input: {
    readonly repository: string;
    readonly sourceSha: string;
  }): Promise<readonly BuildReleaseArtifact[]> {
    const [owner, repo] = z
      .tuple([z.string().min(1), z.string().min(1)])
      .parse(input.repository.split("/"));
    try {
      const workflow = await this.octokit.request(
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}",
        { owner, repo, workflow_id: "pr-build.yml" }
      );
      const listed = await this.octokit.request(
        "GET /repos/{owner}/{repo}/actions/artifacts",
        {
          owner,
          repo,
          name: `build-manifest-${input.sourceSha}`,
          per_page: 100,
        }
      );
      const artifacts = artifactListSchema.parse(listed.data);
      const output: BuildReleaseArtifact[] = [];
      for (const artifact of artifacts.artifacts) {
        if (artifact.expired) continue;
        const response = await this.octokit.request(
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
          { owner, repo, run_id: artifact.workflow_run.id }
        );
        const run = runSchema.parse(response.data);
        if (run.status !== "completed" || run.conclusion !== "success")
          continue;
        if (
          run.id !== artifact.workflow_run.id ||
          run.workflow_id !== workflow.data.id
        ) {
          throw new BuildReleaseError(
            "release_provenance",
            "Artifact producer is not PR Build"
          );
        }
        const archive = await this.octokit.request(
          "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
          { owner, repo, artifact_id: artifact.id, archive_format: "zip" }
        );
        const bytes = Buffer.from(archive.data as ArrayBuffer);
        if (
          bytes.length > MAX_BYTES ||
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
            artifact.digest
        ) {
          throw new BuildReleaseError(
            "release_integrity",
            "Build release archive digest/size verification failed"
          );
        }
        const directory = await mkdtemp(join(tmpdir(), "cogni-release-"));
        let payload: unknown;
        try {
          const archivePath = join(directory, "release.zip");
          await writeFile(archivePath, bytes);
          const { stdout } = await execFileAsync(
            "unzip",
            ["-p", archivePath, "build-manifest.json"],
            { maxBuffer: MAX_BYTES, timeout: 10000 }
          );
          payload = JSON.parse(stdout);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        output.push({
          id: artifact.id,
          digest: artifact.digest,
          name: artifact.name,
          runId: run.id,
          repository: run.repository.full_name,
          headRepository: run.head_repository.full_name,
          sourceSha: run.head_sha,
          workflowPath: run.path,
          event: run.event,
          headBranch: run.head_branch,
          payload,
        });
      }
      return output;
    } catch (error) {
      if (error instanceof BuildReleaseError) throw error;
      throw new BuildReleaseError(
        "release_unavailable",
        "Unable to read/validate bounded CI release artifacts; inspect PR Build and retry"
      );
    }
  }
}
