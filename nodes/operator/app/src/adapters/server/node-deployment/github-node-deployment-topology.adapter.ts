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
