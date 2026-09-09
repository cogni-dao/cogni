// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Typed materialization entrypoint for the existing GitHub Actions deploy-branch writer.
 * It owns catalog placement, immutable OCI bundle verification, and desired-state
 * rendering. It performs no git, secret, provider mutation, or cluster I/O.
 */

import { execFile } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";

import { parseRepoSpec, resolveNodeArtifactBundle } from "@cogni/repo-spec";
import { parse, stringify } from "yaml";

import { buildComputeWorkloadManifest } from "@/features/compute/compute-workload-manifest";
import { buildComputeSecretResources } from "@/features/compute/compute-workload-secret-manifests";
import {
  buildNodeBundleTagRef,
  NODE_BUNDLE_PAYLOAD_FILE,
  verifyNodeBundleManifest,
} from "@/features/compute/node-artifact-bundle-oci";
import {
  deploymentEnvironmentSchema,
  resolveNodeDeploymentProvider,
} from "@/features/compute/node-deployment-provider";
import {
  resolveDeploymentTargets,
  resolvePromoteDeploymentTargets,
} from "@/features/compute/node-deployment-targets";
import { assertDeclaredNodeDeployment } from "@/features/compute/node-services-workload-spec";
import { hostForNode } from "@/shared/node-registry/resolve";

const options = {
  catalog: { type: "string" },
  "catalog-root": { type: "string" },
  environment: { type: "string" },
  "print-provider": { type: "boolean", default: false },
  "flight-targets-json": { type: "string" },
  "promote-targets-csv": { type: "string" },
  "legacy-k3s-targets-json": { type: "string" },
  "catalog-projection-targets-json": { type: "string" },
  "github-output": { type: "string" },
  "repo-spec": { type: "string" },
  bundle: { type: "string" },
  "bundle-ref": { type: "string" },
  "bundle-repository": { type: "string" },
  "source-sha": { type: "string" },
  domain: { type: "string" },
  "output-dir": { type: "string" },
} as const;

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const { values } = parseArgs({ options, strict: true });
  const environment = deploymentEnvironmentSchema.parse(
    required(values.environment, "--environment")
  );

  if (values["flight-targets-json"]) {
    await selectDeploymentTargets({
      catalogRoot: required(values["catalog-root"], "--catalog-root"),
      environment,
      flightTargetsJson: values["flight-targets-json"],
      githubOutput: required(values["github-output"], "--github-output"),
    });
    return;
  }

  if (values["catalog-projection-targets-json"]) {
    await projectCatalogTargets({
      catalogRoot: required(values["catalog-root"], "--catalog-root"),
      environment,
      targetsJson: values["catalog-projection-targets-json"],
      outputDir: required(values["output-dir"], "--output-dir"),
    });
    return;
  }

  if (values["legacy-k3s-targets-json"]) {
    await selectPromoteTargets({
      catalogRoot: required(values["catalog-root"], "--catalog-root"),
      environment,
      promoteTargetsCsv: values["promote-targets-csv"] ?? "",
      legacyK3sTargetsJson: values["legacy-k3s-targets-json"],
      githubOutput: required(values["github-output"], "--github-output"),
    });
    return;
  }

  const catalogFile = required(values.catalog, "--catalog");
  const catalog = parse(await readFile(catalogFile, "utf8")) as unknown;
  const provider = resolveNodeDeploymentProvider({ catalog, environment });

  if (values["print-provider"]) {
    process.stdout.write(`${provider}\n`);
    return;
  }

  if (provider !== "akash") {
    throw new Error(
      `[materialize-compute-workload] Refusing to replace the ${provider} overlay; materialization is only valid for catalog-selected external compute`
    );
  }

  const catalogIdentity = parseCatalogIdentity(catalog);
  const sourceSha = required(values["source-sha"], "--source-sha");
  const repoSpecFile = required(values["repo-spec"], "--repo-spec");
  const spec = parseRepoSpec(await readFile(repoSpecFile, "utf8"));
  // Earliest operator-owned read of the node's own repo-spec — deliberately before
  // any OCI pull. A node with no `deployment:` block would otherwise materialize a
  // valid-looking workload from the legacy no-secrets fallback and die terminally
  // at reconcile with an error that names nothing the author can act on.
  assertDeclaredNodeDeployment({
    spec,
    slug: catalogIdentity.slug,
    sourceSha,
  });
  const bundleInput = await resolveBundleInput({
    bundleFile: values.bundle,
    bundleRef: values["bundle-ref"],
    bundleRepository: values["bundle-repository"],
    sourceSha,
  });
  const domain = required(values.domain, "--domain");
  const outputDir = required(values["output-dir"], "--output-dir");

  const bundle = resolveNodeArtifactBundle(spec, bundleInput.payload, {
    sourceSha,
    repository: catalogIdentity.repository,
  });
  if (bundle.nodeId !== catalogIdentity.nodeId) {
    throw new Error(
      `[materialize-compute-workload] Catalog node_id mismatch: expected ${catalogIdentity.nodeId}, received ${bundle.nodeId}`
    );
  }

  const manifest = buildComputeWorkloadManifest({
    slug: catalogIdentity.slug,
    environment,
    bundleRef: bundleInput.ref,
    bundle,
    publicHost: hostForNode(
      catalogIdentity.slug,
      catalogIdentity.isPrimaryHost,
      domain
    ),
  });
  const secretResources = buildComputeSecretResources({
    slug: catalogIdentity.slug,
    environment,
    secretRefs: bundle.services.flatMap(
      (service) => service.service.secretRefs
    ),
  });
  const kustomization = {
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    namespace: `cogni-${environment}`,
    resources: [
      "compute-workload.yaml",
      ...secretResources.map((resource) => resource.file),
    ],
  };

  await mkdir(outputDir, { recursive: true });
  await writeAtomically(
    `${outputDir}/compute-workload.yaml`,
    stringify(manifest, { lineWidth: 0 })
  );
  await Promise.all(
    secretResources.map(({ file, manifest: resource }) =>
      writeAtomically(
        `${outputDir}/${file}`,
        stringify(resource, { lineWidth: 0 })
      )
    )
  );
  await writeAtomically(
    `${outputDir}/kustomization.yaml`,
    stringify(kustomization, { lineWidth: 0 })
  );
  process.stdout.write(
    `${JSON.stringify({ provider, node: catalogIdentity.slug, outputDir })}\n`
  );
}

async function selectDeploymentTargets(input: {
  readonly catalogRoot: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly flightTargetsJson: string;
  readonly githubOutput: string;
}): Promise<void> {
  const parsed = parseStringArray(
    input.flightTargetsJson,
    "--flight-targets-json"
  );
  const rows = await readCatalogRows(input.catalogRoot);
  const {
    deployment,
    substrate,
    external,
    providers,
    k3s,
    k3sNodes,
    sourceRepositories,
    sourceShas,
  } = resolveDeploymentTargets({
    catalogRows: rows,
    environment: input.environment,
    flightTargets: parsed,
  });
  const outputs = {
    deployment_node_targets_json: JSON.stringify(deployment),
    has_deployment_node_targets: String(deployment.length > 0),
    substrate_node_targets_json: JSON.stringify(substrate),
    has_substrate_node_targets: String(substrate.length > 0),
    external_compute_node_targets_json: JSON.stringify(external),
    has_external_compute_node_targets: String(external.length > 0),
    k3s_targets_json: JSON.stringify(k3s),
    k3s_node_targets_json: JSON.stringify(k3sNodes),
    has_k3s_node_targets: String(k3sNodes.length > 0),
    deployment_provider_by_target_json: JSON.stringify(providers),
    source_repository_by_target_json: JSON.stringify(sourceRepositories),
    source_sha_by_target_json: JSON.stringify(sourceShas),
  };
  await appendFile(
    input.githubOutput,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8"
  );
}

async function selectPromoteTargets(input: {
  readonly catalogRoot: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly promoteTargetsCsv: string;
  readonly legacyK3sTargetsJson: string;
  readonly githubOutput: string;
}): Promise<void> {
  const requestedTargets = input.promoteTargetsCsv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selection = resolvePromoteDeploymentTargets({
    catalogRows: await readCatalogRows(input.catalogRoot),
    environment: input.environment,
    requestedTargets,
    legacyK3sTargets: parseStringArray(
      input.legacyK3sTargetsJson,
      "--legacy-k3s-targets-json"
    ),
  });
  const outputs = {
    targets_json: JSON.stringify(selection.deployment),
    has_targets: String(selection.deployment.length > 0),
    node_targets_json: JSON.stringify(selection.substrate),
    has_node_targets: String(selection.substrate.length > 0),
    k3s_targets_json: JSON.stringify(selection.k3s),
    has_k3s_targets: String(selection.k3s.length > 0),
    k3s_node_targets_json: JSON.stringify(selection.k3sNodes),
    has_k3s_node_targets: String(selection.k3sNodes.length > 0),
    external_compute_node_targets_json: JSON.stringify(selection.external),
    has_external_compute_node_targets: String(selection.external.length > 0),
    deployment_provider_by_target_json: JSON.stringify(selection.providers),
    source_repository_by_target_json: JSON.stringify(
      selection.sourceRepositories
    ),
    source_sha_by_target_json: JSON.stringify(selection.sourceShas),
  };
  await appendFile(
    input.githubOutput,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8"
  );
}

async function projectCatalogTargets(input: {
  readonly catalogRoot: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly targetsJson: string;
  readonly outputDir: string;
}): Promise<void> {
  const targets = parseStringArray(
    input.targetsJson,
    "--catalog-projection-targets-json"
  );
  const rows = await readCatalogRows(input.catalogRoot);
  const byName = new Map(rows.map((row) => [row.name, row] as const));
  await rm(input.outputDir, { recursive: true, force: true });
  await mkdir(input.outputDir, { recursive: true });
  for (const target of targets) {
    const row = byName.get(target);
    if (!row) {
      throw new Error(
        `[materialize-compute-workload] Unknown catalog projection target: ${target}`
      );
    }
    if (
      resolveNodeDeploymentProvider({
        catalog: row,
        environment: input.environment,
      }) !== "k3s"
    ) {
      throw new Error(
        `[materialize-compute-workload] Refusing to project non-k3s target: ${target}`
      );
    }
    await copyFile(
      join(input.catalogRoot, `${target}.yaml`),
      join(input.outputDir, `${target}.yaml`)
    );
  }
}

async function readCatalogRows(
  catalogRoot: string
): Promise<readonly Record<string, unknown>[]> {
  const names = (await readdir(catalogRoot))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  return Promise.all(
    names.map(
      async (name) =>
        parse(await readFile(join(catalogRoot, name), "utf8")) as Record<
          string,
          unknown
        >
    )
  );
}

function parseStringArray(value: string, flag: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error(
      `[materialize-compute-workload] ${flag} must be a string array`
    );
  }
  return parsed as string[];
}

async function resolveBundleInput(input: {
  readonly bundleFile: string | undefined;
  readonly bundleRef: string | undefined;
  readonly bundleRepository: string | undefined;
  readonly sourceSha: string;
}): Promise<{ readonly ref: string; readonly payload: unknown }> {
  if (input.bundleFile || input.bundleRef) {
    const bundleFile = required(input.bundleFile, "--bundle");
    return {
      ref: required(input.bundleRef, "--bundle-ref"),
      payload: JSON.parse(await readFile(bundleFile, "utf8")) as unknown,
    };
  }

  const repository = required(input.bundleRepository, "--bundle-repository");
  const tagRef = buildNodeBundleTagRef({
    repository,
    sourceSha: input.sourceSha,
  });
  const { stdout: digestOutput } = await execFileAsync("oras", [
    "resolve",
    tagRef,
  ]);
  const digest = digestOutput.trim();
  const provisionalRef = `${repository}@${digest}`;
  const { stdout: manifestOutput } = await execFileAsync("oras", [
    "manifest",
    "fetch",
    provisionalRef,
  ]);
  const { digestRef } = verifyNodeBundleManifest({
    repository,
    digest,
    manifest: JSON.parse(manifestOutput) as unknown,
  });
  const directory = await mkdtemp(join(tmpdir(), "cogni-node-bundle-"));
  try {
    await execFileAsync("oras", ["pull", "--output", directory, digestRef]);
    const files = await readdir(directory);
    if (files.length !== 1 || files[0] !== NODE_BUNDLE_PAYLOAD_FILE) {
      throw new Error(
        `[materialize-compute-workload] OCI bundle must contain only ${NODE_BUNDLE_PAYLOAD_FILE}`
      );
    }
    return {
      ref: digestRef,
      payload: JSON.parse(
        await readFile(join(directory, NODE_BUNDLE_PAYLOAD_FILE), "utf8")
      ) as unknown,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function required(value: string | undefined, flag: string): string {
  if (!value)
    throw new Error(`[materialize-compute-workload] ${flag} is required`);
  return value;
}

function parseCatalogIdentity(input: unknown): {
  readonly slug: string;
  readonly nodeId: string;
  readonly repository: string;
  readonly isPrimaryHost: boolean;
} {
  if (!input || typeof input !== "object") {
    throw new Error("[materialize-compute-workload] catalog must be an object");
  }
  const row = input as Record<string, unknown>;
  if (typeof row.name !== "string" || typeof row.node_id !== "string") {
    throw new Error(
      "[materialize-compute-workload] catalog name + node_id are required"
    );
  }
  if (typeof row.source_repo !== "string") {
    throw new Error(
      "[materialize-compute-workload] external compute requires catalog source_repo"
    );
  }
  const match = row.source_repo.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (!match) {
    throw new Error(
      "[materialize-compute-workload] source_repo must be a GitHub repository URL"
    );
  }
  return {
    slug: row.name,
    nodeId: row.node_id,
    repository: `${match[1]}/${match[2]}`.toLowerCase(),
    isPrimaryHost: row.is_primary_host === true,
  };
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
