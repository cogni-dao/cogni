// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Typed deployment-target planner for the operator's flight/promote workflows. It partitions
 * the requested targets by catalog placement and refuses node-deploy cells
 * (`node_on_deploy_verb`). Workload rendering (ComputeWorkload / XComputeWorkload) was deleted
 * by task.5411. It performs no git, secret, provider mutation, or cluster I/O.
 */

import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { parse } from "yaml";

import {
  deploymentEnvironmentSchema,
  resolveNodeDeploymentProvider,
} from "../src/features/compute/node-deployment-provider";
import {
  decideNodeDeployExclusion,
  isInfraOnlyPromoteNoop,
  resolveDeploymentTargets,
  resolvePromoteDeploymentTargets,
} from "../src/features/compute/node-deployment-targets";

const options = {
  catalog: { type: "string" },
  "catalog-root": { type: "string" },
  environment: { type: "string" },
  "print-provider": { type: "boolean", default: false },
  "flight-targets-json": { type: "string" },
  "promote-targets-csv": { type: "string" },
  "legacy-k3s-targets-json": { type: "string" },
  // Run-wide preview-forward mode (bug.5195). The planner intersects it with each row's
  // `envs:` membership, so a production-only node never reaches deploy/preview-<node>.
  "preview-forward": { type: "string" },
  "catalog-projection-targets-json": { type: "string" },
  // GitHub owner/name of the repository running this workflow (bug.5510): the
  // source repository of in-repo nodes such as operator. Defaults to the
  // Actions-provided GITHUB_REPOSITORY so the existing workflow call sites need
  // no edit; absent both, target selection fails closed.
  "parent-repository": { type: "string" },
  "github-output": { type: "string" },
  "repo-spec": { type: "string" },
  bundle: { type: "string" },
  "bundle-ref": { type: "string" },
  "bundle-repository": { type: "string" },
  "destination-accepted-overlay-dir": { type: "string" },
  "preview-overlay-dir": { type: "string" },
  "source-sha": { type: "string" },
  domain: { type: "string" },
  // Public Cloudflare zone identifier (NOT a credential — it appears in the dashboard URL).
  // Optional: the Crossplane composite treats absent DNS intent as "publish the CNAME target
  // you WOULD write, but write no record", so a caller without a zone still gets observable
  // intent instead of a hard failure.
  "dns-zone-id": { type: "string" },
  // Environment VM host serving the shared substrate ports (5432/5435/6379/4000/7233) — the
  // value the legacy controller read back out of the DATABASE_URL secret. NOT derivable from
  // --domain: that is the Cloudflare-PROXIED public apex, which drops every non-HTTP port. The
  // caller derives it with vm_host_for_env() (scripts/setup/lib/fork-identity.sh), the same
  // primitive provisioning used to publish the VM's unproxied A record — see
  // .github/actions/materialize-compute-workload/action.yml. Still optional here: absent omits
  // spec.runtime, degrading exactly like the legacy path did on an unparseable DSN.
  "substrate-host": { type: "string" },
  "output-dir": { type: "string" },
} as const;

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
      parentRepository: parentRepository(values["parent-repository"]),
      ...(values["source-sha"] !== undefined && {
        parentSourceSha: values["source-sha"],
      }),
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
      previewForwardMode: values["preview-forward"] === "true",
      parentRepository: parentRepository(values["parent-repository"]),
      githubOutput: required(values["github-output"], "--github-output"),
    });
    return;
  }

  throw new Error(
    "[materialize-compute-workload] workload rendering was deleted (task.5411): every node is deployed only by POST /api/v1/deploy/workloads; only the planner modes (--flight-targets-json, --legacy-k3s-targets-json, --catalog-projection-targets-json) remain"
  );
}

async function selectDeploymentTargets(input: {
  readonly catalogRoot: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly flightTargetsJson: string;
  readonly parentRepository: string;
  readonly parentSourceSha?: string;
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
    offCluster,
    providers,
    k3s,
    k3sNodes,
    sourceRepositories,
    sourceShas,
    nodeDeploy,
    flight,
  } = resolveDeploymentTargets({
    catalogRows: rows,
    environment: input.environment,
    flightTargets: parsed,
    parentRepository: input.parentRepository,
    ...(input.parentSourceSha !== undefined && {
      parentSourceSha: input.parentSourceSha,
    }),
  });
  // ONE_WRITER_PER_NODE_LANE (story.5137): `compute_api.<env>=node-deploy` cells belong to POST
  // /api/v1/deploy/workloads. They are excluded above; REFUSE when nothing else is left (never a
  // silent green no-op), otherwise say loudly which targets this flight skipped.
  refuseOrWarnNodeDeploy({
    lane: "flight",
    environment: input.environment,
    requestedTargets: parsed,
    nodeDeploy,
    remainingTargets: flight,
  });
  const outputs = {
    // The per-node job matrices' input: the request minus node-deploy cells (story.5137).
    flight_targets_json: JSON.stringify(flight),
    has_flight_targets: String(flight.length > 0),
    deployment_node_targets_json: JSON.stringify(deployment),
    has_deployment_node_targets: String(deployment.length > 0),
    substrate_node_targets_json: JSON.stringify(substrate),
    has_substrate_node_targets: String(substrate.length > 0),
    external_compute_node_targets_json: JSON.stringify(offCluster),
    has_external_compute_node_targets: String(offCluster.length > 0),
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
  readonly previewForwardMode: boolean;
  readonly parentRepository: string;
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
    previewForwardMode: input.previewForwardMode,
    parentRepository: input.parentRepository,
  });
  // ONE_WRITER_PER_NODE_LANE (story.5137): refuse a request that names only `node-deploy` cells.
  refuseOrWarnNodeDeploy({
    lane: "promote",
    environment: input.environment,
    requestedTargets,
    nodeDeploy: selection.nodeDeploy,
    remainingTargets: [...selection.deployment, ...selection.infra],
  });
  // AN EMPTY APP PROMOTE IS A REFUSAL, NOT A SILENT SUCCESS (bug.5203). Every downstream job
  // gates on `has_targets`, so a promote that resolves nothing otherwise SKIPS its way to a
  // green conclusion indistinguishable from a successful deploy.
  //
  // Observed twice on 2026-09-17: the node-merge webhook dispatches env=preview, #2238 retired
  // every preview node slot, so beacon's and toks5's merges each left only
  // `##[warning]Skipping targets not in the preview node-set` under a SUCCESS badge. A node
  // owner merges a fix, sees green, and nothing shipped.
  //
  // This belongs HERE, at the dispatch boundary, and NOT in resolvePromoteDeploymentTargets:
  // that resolver's contract is EXCLUSION — "does not admit an off-cluster node outside the
  // selected environment" asserts it returns [] rather than throwing, and it is right. The
  // question "I was ASKED to deploy and deployed nothing" is only answerable where the request
  // is known. Fleet-wide promotes (no explicit CSV) legitimately match nothing and stay silent.
  //
  // Infra images are the typed exception (bug.5361): pr-build legitimately resolves them, but
  // their runtime is Compose and never the app promotion lane. Report that as a loud, truthful
  // no-op instead of rejecting a healthy main merge. Unknown targets still fail in the resolver;
  // an out-of-environment node or rejected service still hits the refusal below.
  if (requestedTargets.length > 0 && selection.deployment.length === 0) {
    if (isInfraOnlyPromoteNoop({ requestedTargets, selection })) {
      const message =
        `[materialize-compute-workload] promote resolved only catalog infra artifact(s) ` +
        `(${selection.infra.join(", ")}); none deploy through the '${input.environment}' app lane. ` +
        `Explicit no-op: no app digest was promoted.`;
      process.stderr.write(`::warning::${message}\n`);
    } else {
      throw new Error(
        `[materialize-compute-workload] promote named ${requestedTargets.length} target(s) ` +
          `(${requestedTargets.join(", ")}) but NONE deploy to '${input.environment}'. ` +
          `Refusing to report a no-op promote as success — check those rows' catalog 'envs:'.`
      );
    }
  }

  const outputs = {
    targets_json: JSON.stringify(selection.deployment),
    has_targets: String(selection.deployment.length > 0),
    node_targets_json: JSON.stringify(selection.substrate),
    has_node_targets: String(selection.substrate.length > 0),
    k3s_targets_json: JSON.stringify(selection.k3s),
    has_k3s_targets: String(selection.k3s.length > 0),
    k3s_node_targets_json: JSON.stringify(selection.k3sNodes),
    has_k3s_node_targets: String(selection.k3sNodes.length > 0),
    external_compute_node_targets_json: JSON.stringify(selection.offCluster),
    has_external_compute_node_targets: String(selection.offCluster.length > 0),
    deployment_provider_by_target_json: JSON.stringify(selection.providers),
    source_repository_by_target_json: JSON.stringify(
      selection.sourceRepositories
    ),
    source_sha_by_target_json: JSON.stringify(selection.sourceShas),
    preview_forward_by_target_json: JSON.stringify(selection.previewForward),
  };
  await appendFile(
    input.githubOutput,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8"
  );
}

/**
 * CD4 / ONE_WRITER_PER_NODE_LANE guard for the old flight/promote path. The decision lives in the
 * feature (`decideNodeDeployExclusion`, unit-tested); this only performs the I/O.
 */
function refuseOrWarnNodeDeploy(
  input: Parameters<typeof decideNodeDeployExclusion>[0]
): void {
  const decision = decideNodeDeployExclusion(input);
  if (decision.kind === "refuse") {
    throw new Error(`[materialize-compute-workload] ${decision.message}`);
  }
  if (decision.kind === "warn") {
    process.stderr.write(
      `::warning::[materialize-compute-workload] ${decision.message}\n`
    );
  }
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

function parentRepository(value: string | undefined): string {
  return required(
    // biome-ignore lint/style/noProcessEnv: the Actions runner identity of the parent repository; the reviewed workflow call sites pass no flag
    value || process.env.GITHUB_REPOSITORY,
    "--parent-repository (or GITHUB_REPOSITORY)"
  );
}

function required(value: string | undefined, flag: string): string {
  if (!value)
    throw new Error(`[materialize-compute-workload] ${flag} is required`);
  return value;
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === "materialize-compute-workload.ts"
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
