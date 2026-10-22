// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type DeploymentEnvironment,
  resolveNodeDeploymentProvider,
} from "./node-deployment-provider";

export interface DeploymentTargetSelection {
  readonly deployment: readonly string[];
  readonly substrate: readonly string[];
  readonly offCluster: readonly string[];
  readonly providers: Readonly<Record<string, "akash" | "k3s">>;
  readonly k3s: readonly string[];
  readonly k3sNodes: readonly string[];
  /**
   * Every selected node target's canonical GitHub `owner/name` (bug.5510). A
   * remote-source node carries its catalog `source_repo`; an in-repo node
   * (no `source_repo`, e.g. operator) is built from the repository running the
   * workflow, so it carries `parentRepository`. The deploy-branch maintenance
   * fence compares this exact value with an audited receipt's
   * `request.sourceRepository`; an empty value is never a valid identity.
   */
  readonly sourceRepositories: Readonly<Record<string, string>>;
  readonly sourceShas: Readonly<Record<string, string>>;
}

export interface PromoteDeploymentTargetSelection
  extends DeploymentTargetSelection {
  /** Explicitly requested infra artifacts that never enter the app deployment lane. */
  readonly infra: readonly string[];
  /**
   * Per-target preview-forward eligibility (bug.5195). Preview-forward reads a
   * node's digest from `deploy/preview-<node>`, so it is only ever valid for a
   * target the catalog still places in `preview`. It used to be ONE run-wide
   * flag selected by the ABSENCE of `source_sha` — which is how a promote of a
   * production-only node (toks5, `envs: [production]`) tried to check out a
   * branch that does not exist and died on a raw `git` exit 1 before
   * `promote-k8s` ever ran. The UI never sends `source_sha`, so that path was
   * the DEFAULT one, not an edge case.
   *
   * A target that has left preview is not an error — it simply resolves its
   * digest from the reviewed catalog pin instead.
   */
  readonly previewForward: Readonly<Record<string, boolean>>;
}

/** Stable identity for catalog cells that can change a candidate-a workload. */
export function candidateDeploymentFingerprint(
  row: Readonly<Record<string, unknown>>
): string {
  return JSON.stringify({
    name: catalogScalar(row.name),
    type: catalogScalar(row.type),
    nodeId: catalogScalar(row.node_id),
    primaryHost: catalogScalar(row.is_primary_host),
    port: catalogScalar(row.port),
    nodePort: catalogScalar(row.node_port),
    sourceRepository: catalogScalar(row.source_repo),
    sourceSha: catalogScalar(row.source_sha),
    imageRepository: catalogScalar(row.image_repository),
    candidateMember: isInEnvironment(row, "candidate-a"),
    candidateBranch: catalogScalar(row.candidate_a_branch),
    deploymentProvider: candidateCatalogCell(row, "deployment_provider"),
    computeApi: candidateCatalogCell(row, "compute_api"),
    leaseGeneration: candidateCatalogCell(row, "lease_generation"),
    requiredPlacementCountries: candidateCatalogCell(
      row,
      "required_placement_countries"
    ),
    bootRecovery: candidateCatalogCell(row, "boot_recovery"),
  });
}

export function isInfraOnlyPromoteNoop(input: {
  readonly requestedTargets: readonly string[];
  readonly selection: PromoteDeploymentTargetSelection;
}): boolean {
  return (
    input.requestedTargets.length > 0 &&
    input.selection.deployment.length === 0 &&
    input.selection.infra.length === input.requestedTargets.length
  );
}

/** Partition one flight once; downstream matrix cells reuse this exact decision. */
export function resolveDeploymentTargets(input: {
  readonly catalogRows: readonly Readonly<Record<string, unknown>>[];
  readonly environment: DeploymentEnvironment;
  readonly flightTargets: readonly string[];
  /** GitHub `owner/name` running this workflow; the source of in-repo nodes. */
  readonly parentRepository: string;
}): DeploymentTargetSelection {
  const parentRepository = parseParentRepository(input.parentRepository);
  const byName = new Map(
    input.catalogRows.map((row) => [row.name, row] as const)
  );
  const providers: Record<string, "akash" | "k3s"> = {};
  const deployment: string[] = [];
  const substrate: string[] = [];
  const offCluster: string[] = [];
  const k3s: string[] = [];
  const k3sNodes: string[] = [];
  const sourceRepositories: Record<string, string> = {};
  const sourceShas: Record<string, string> = {};

  for (const target of input.flightTargets) {
    const row = byName.get(target);
    if (!row)
      throw new Error(`[deployment-targets] Unknown flight target: ${target}`);
    if (row.type === "node" && !isInEnvironment(row, input.environment)) {
      throw new Error(
        `[deployment-targets] Flight target ${target} is not configured for ${input.environment}`
      );
    }
    const provider = resolveNodeDeploymentProvider({
      catalog: row,
      environment: input.environment,
    });
    providers[target] = provider;
    if (provider === "k3s") k3s.push(target);
    if (row.type !== "node") continue;
    deployment.push(target);
    substrate.push(target);
    if (provider === "akash") {
      offCluster.push(target);
      sourceRepositories[target] = parseSourceRepository(row, target);
      sourceShas[target] = parseSourceSha(row, target);
    } else {
      k3sNodes.push(target);
      sourceRepositories[target] = resolveNodeSourceRepository(
        row,
        target,
        parentRepository
      );
    }
  }

  return {
    deployment,
    substrate,
    offCluster,
    providers,
    k3s,
    k3sNodes,
    sourceRepositories,
    sourceShas,
  };
}

/**
 * Add catalog-selected off-cluster nodes to the mature promote target list without
 * reimplementing or widening the legacy k3s resolver. The existing list remains
 * the sole authority for k3s eligibility, ordering, and overlay presence.
 */
export function resolvePromoteDeploymentTargets(input: {
  readonly catalogRows: readonly Readonly<Record<string, unknown>>[];
  readonly environment: DeploymentEnvironment;
  readonly requestedTargets: readonly string[];
  readonly legacyK3sTargets: readonly string[];
  /** Run-wide preview-forward mode, decided by the caller. Off ⇒ the map is all false. */
  readonly previewForwardMode?: boolean;
  /** GitHub `owner/name` running this workflow; the source of in-repo nodes. */
  readonly parentRepository: string;
}): PromoteDeploymentTargetSelection {
  const parentRepository = parseParentRepository(input.parentRepository);
  const byName = new Map(
    input.catalogRows.map((row) => [row.name, row] as const)
  );
  for (const target of input.requestedTargets) {
    if (!byName.has(target)) {
      throw new Error(`[deployment-targets] Unknown promote target: ${target}`);
    }
  }

  const offClusterCandidates =
    input.requestedTargets.length > 0
      ? input.requestedTargets
      : input.catalogRows.flatMap((row) =>
          typeof row.name === "string" ? [row.name] : []
        );
  const offCluster: string[] = [];
  const infra = input.requestedTargets.filter(
    (target) => byName.get(target)?.type === "infra"
  );
  const sourceRepositories: Record<string, string> = {};
  const sourceShas: Record<string, string> = {};
  for (const target of offClusterCandidates) {
    const row = byName.get(target);
    if (!row || row.type !== "node" || !isInEnvironment(row, input.environment))
      continue;
    // REMOTE_SOURCE_IS_NOT_PLACEMENT (bug: node-template prod promote,
    // story.5016) — a node whose image is built by its own repo (source_repo
    // set) needs its reviewed catalog source_sha resolved for image-tag/digest
    // lookup regardless of WHERE it is placed this env. Off-cluster (akash)
    // placement is a separate axis: it additionally needs the OCI bundle
    // materialized. Gating source_sha resolution on akash-only silently broke
    // resolve_remote_source_sha's "operator source_sha + reviewed catalog
    // source_sha" fallback for any remote-source node not (yet) opted into
    // akash for this specific env — e.g. node-template, which is akash-placed
    // for candidate-a only, still k3s for preview/production.
    const isRemoteSource = typeof row.source_repo === "string";
    const isOffCluster =
      resolveNodeDeploymentProvider({
        catalog: row,
        environment: input.environment,
      }) === "akash";
    if (isOffCluster) {
      offCluster.push(target);
    }
    if (isOffCluster || isRemoteSource) {
      sourceRepositories[target] = parseSourceRepository(row, target);
      sourceShas[target] = parseSourceSha(row, target);
    } else {
      // In-repo node: its image and deploy source are this parent repository.
      sourceRepositories[target] = resolveNodeSourceRepository(
        row,
        target,
        parentRepository
      );
    }
  }

  const k3s = input.legacyK3sTargets.filter((target) => {
    const row = byName.get(target);
    if (!row) {
      throw new Error(`[deployment-targets] Unknown legacy target: ${target}`);
    }
    return (
      resolveNodeDeploymentProvider({
        catalog: row,
        environment: input.environment,
      }) === "k3s"
    );
  });
  const deployment = [
    ...k3s,
    ...offCluster.filter((name) => !k3s.includes(name)),
  ];
  const providers: Record<string, "akash" | "k3s"> = {};
  const substrate: string[] = [];
  const k3sNodes: string[] = [];
  const previewForward: Record<string, boolean> = {};
  for (const target of deployment) {
    const row = byName.get(target);
    if (!row)
      throw new Error(`[deployment-targets] Unknown deploy target: ${target}`);
    const provider = resolveNodeDeploymentProvider({
      catalog: row,
      environment: input.environment,
    });
    providers[target] = provider;
    // `envs:` is the SELECTOR (CATALOG_IS_SSOT), not the absence of an input.
    previewForward[target] =
      input.previewForwardMode === true && isInEnvironment(row, "preview");
    if (row.type === "node") {
      substrate.push(target);
      if (provider === "k3s") k3sNodes.push(target);
    }
  }

  return {
    deployment,
    substrate,
    offCluster,
    providers,
    k3s,
    k3sNodes,
    sourceRepositories,
    sourceShas,
    previewForward,
    infra,
  };
}

function parseSourceSha(
  row: Readonly<Record<string, unknown>>,
  target: string
): string {
  if (
    typeof row.source_sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(row.source_sha)
  ) {
    throw new Error(
      `[deployment-targets] Off-cluster target ${target} requires a 40-character source_sha`
    );
  }
  return row.source_sha.toLowerCase();
}

function isInEnvironment(
  row: Readonly<Record<string, unknown>>,
  environment: DeploymentEnvironment
): boolean {
  return (
    Array.isArray(row.envs) &&
    row.envs.every((value) => typeof value === "string") &&
    row.envs.includes(environment)
  );
}

function candidateCatalogCell(
  row: Readonly<Record<string, unknown>>,
  key: string
): unknown {
  const map = row[key];
  if (typeof map !== "object" || map === null || Array.isArray(map))
    return null;
  return (map as Readonly<Record<string, unknown>>)["candidate-a"] ?? null;
}

function catalogScalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : null;
}

const GITHUB_REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** Case-normalized like catalog `source_repo`; fails closed on empty/malformed input. */
function parseParentRepository(value: string): string {
  if (!GITHUB_REPOSITORY.test(value)) {
    throw new Error(
      "[deployment-targets] parentRepository must be a GitHub owner/name"
    );
  }
  return value.toLowerCase();
}

function resolveNodeSourceRepository(
  row: Readonly<Record<string, unknown>>,
  target: string,
  parentRepository: string
): string {
  return row.source_repo === undefined
    ? parentRepository
    : parseSourceRepository(row, target);
}

function parseSourceRepository(
  row: Readonly<Record<string, unknown>>,
  target: string
): string {
  if (typeof row.source_repo !== "string") {
    throw new Error(
      `[deployment-targets] Target ${target} requires source_repo`
    );
  }
  const match = row.source_repo.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (!match) {
    throw new Error(
      `[deployment-targets] Target ${target} has invalid source_repo`
    );
  }
  return `${match[1]}/${match[2]}`.toLowerCase();
}
