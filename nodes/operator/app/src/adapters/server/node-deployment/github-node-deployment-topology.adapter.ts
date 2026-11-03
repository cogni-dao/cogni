// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Read display-safe service topology for one (node, environment).
 * A node lane (story.5137) is read from the node-deploy release view: the specs of the
 * releases the sequencer desires, the same rows `GET /api/v1/deploy/workloads` serves.
 * Only the operator lane still reads its exact k3s deploy branch. No XComputeWorkload or
 * node deploy branch is read.
 */

import { LEGACY_DEFAULT_NODE_DEPLOYMENT } from "@cogni/repo-spec";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type {
  NodeDeployedService,
  NodeDeploymentTopologyPort,
  StorePort,
} from "@/ports";

/** The read half of the node-deploy store this adapter needs (the release view). */
export type NodeDeployReleaseReader = Pick<
  StorePort,
  "listDesired" | "getRelease"
>;

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

const kustomizationSchema = z.object({
  resources: z.array(z.string()),
});

/** The only lane still on k3s/Argo (mirrors features/compute OPERATOR_LANE_SLUG; adapters may not import features). */
const OPERATOR_LANE_SLUG = "operator";

const deploymentSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export class GitHubNodeDeploymentTopologyAdapter
  implements NodeDeploymentTopologyPort
{
  constructor(
    private readonly files: NodeDeploymentFileReader,
    private readonly parent: { readonly owner: string; readonly repo: string },
    private readonly releases?: () => NodeDeployReleaseReader
  ) {}

  async listServices(input: {
    readonly nodeId: string;
    readonly slug: string;
    readonly environment: "candidate-a" | "preview" | "production";
  }): Promise<readonly NodeDeployedService[]> {
    const slug = deploymentSlugSchema.parse(input.slug);
    if (slug !== OPERATOR_LANE_SLUG) {
      return this.listNodeDeployServices(input.nodeId, input.environment);
    }

    // The operator/control-plane lane still runs the standard node app on k3s. Its exact deploy
    // branch names that shared base explicitly; project the provider-neutral stock topology.
    const kustomization = await this.files.fetchFileText({
      owner: this.parent.owner,
      repo: this.parent.repo,
      path: `infra/k8s/overlays/${input.environment}/${slug}/kustomization.yaml`,
      ref: `deploy/${input.environment}-${slug}`,
    });
    if (kustomization !== null) {
      const parsed = kustomizationSchema.parse(parseYaml(kustomization));
      if (
        parsed.resources.some((resource) =>
          /(^|\/)base\/node-app$/.test(resource)
        )
      ) {
        return LEGACY_DEFAULT_NODE_DEPLOYMENT.services.map((service) => ({
          name: service.name,
          visibility: service.visibility,
        }));
      }
    }

    throw new Error("deployed service topology is unavailable");
  }

  /** ONE_WRITER_PER_NODE_LANE: a node lane's topology is the specs its desired releases deploy. */
  private async listNodeDeployServices(
    nodeId: string,
    environment: string
  ): Promise<readonly NodeDeployedService[]> {
    if (!this.releases) {
      throw new Error("deployed service topology is unavailable");
    }
    const store = this.releases();
    const desired = (await store.listDesired(environment)).filter(
      (row) => row.nodeId === nodeId && row.env === environment
    );
    const services: NodeDeployedService[] = [];
    for (const row of desired) {
      const release = await store.getRelease(row.releaseId);
      if (!release) continue;
      services.push({
        name: release.spec.name,
        visibility: "http" in release.spec.expose ? "public" : "private",
      });
    }
    if (services.length === 0) {
      throw new Error("deployed service topology is unavailable");
    }
    return services.sort((a, b) => a.name.localeCompare(b.name));
  }
}
