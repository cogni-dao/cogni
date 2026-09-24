// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Read display-safe service topology from the exact environment deploy branch Argo consumes. */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { NodeDeployedService, NodeDeploymentTopologyPort } from "@/ports";

export interface NodeDeploymentFileReader {
  fetchFileText(input: {
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly ref?: string;
  }): Promise<string | null>;
}

const MAX_DEPLOYMENT_BYTES = 256 * 1024;
const githubNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);

function encodeSafePath(value: string): string {
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(segment)
    )
  ) {
    throw new Error("invalid GitHub file path");
  }
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Read public deploy declarations without placing a cross-org GitHub App credential in candidate.
 * Catalog/deploy repos are public reproducibility surfaces; private forks degrade this module only.
 */
export class PublicGitHubNodeDeploymentFileReader
  implements NodeDeploymentFileReader
{
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchFileText(input: {
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly ref?: string;
  }): Promise<string | null> {
    const owner = githubNameSchema.parse(input.owner);
    const repo = githubNameSchema.parse(input.repo);
    const ref = encodeSafePath(input.ref ?? "main");
    const path = encodeSafePath(input.path);
    const response = await this.fetchImpl(
      `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/refs/heads/${ref}/${path}`,
      {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error("public deployment source unavailable");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_DEPLOYMENT_BYTES
    ) {
      throw new Error("deployment source exceeds size limit");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_DEPLOYMENT_BYTES) {
      throw new Error("deployment source exceeds size limit");
    }
    return new TextDecoder().decode(bytes);
  }
}

const deployedTopologySchema = z.object({
  spec: z.object({
    workload: z.object({
      services: z.array(
        z.object({
          name: z.string().min(1).max(63),
          visibility: z.enum(["public", "private"]),
        })
      ),
    }),
  }),
});

const deploymentSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export class GitHubNodeDeploymentTopologyAdapter
  implements NodeDeploymentTopologyPort
{
  constructor(
    private readonly files: NodeDeploymentFileReader,
    private readonly parent: { readonly owner: string; readonly repo: string }
  ) {}

  async listServices(input: {
    readonly slug: string;
    readonly environment: "candidate-a" | "preview" | "production";
  }): Promise<readonly NodeDeployedService[]> {
    const slug = deploymentSlugSchema.parse(input.slug);
    const text = await this.files.fetchFileText({
      owner: this.parent.owner,
      repo: this.parent.repo,
      path: `infra/k8s/overlays/${input.environment}/${slug}/xcomputeworkload.yaml`,
      ref: `deploy/${input.environment}-${slug}`,
    });
    if (text === null) {
      throw new Error("deployed service topology is unavailable");
    }

    const parsed = deployedTopologySchema.parse(parseYaml(text));
    return parsed.spec.workload.services.map((service) => ({
      name: service.name,
      visibility: service.visibility,
    }));
  }
}
