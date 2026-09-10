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
  readonly sourceRepositories: Readonly<Record<string, string>>;
  readonly sourceShas: Readonly<Record<string, string>>;
}

export type PromoteDeploymentTargetSelection = DeploymentTargetSelection;

/** Partition one flight once; downstream matrix cells reuse this exact decision. */
export function resolveDeploymentTargets(input: {
  readonly catalogRows: readonly Readonly<Record<string, unknown>>[];
  readonly environment: DeploymentEnvironment;
  readonly flightTargets: readonly string[];
}): DeploymentTargetSelection {
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
}): PromoteDeploymentTargetSelection {
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
  const sourceRepositories: Record<string, string> = {};
  const sourceShas: Record<string, string> = {};
  for (const target of offClusterCandidates) {
    const row = byName.get(target);
    if (!row || row.type !== "node" || !isInEnvironment(row, input.environment))
      continue;
    if (
      resolveNodeDeploymentProvider({
        catalog: row,
        environment: input.environment,
      }) !== "akash"
    )
      continue;
    offCluster.push(target);
    sourceRepositories[target] = parseSourceRepository(row, target);
    sourceShas[target] = parseSourceSha(row, target);
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
  for (const target of deployment) {
    const row = byName.get(target);
    if (!row)
      throw new Error(`[deployment-targets] Unknown deploy target: ${target}`);
    const provider = resolveNodeDeploymentProvider({
      catalog: row,
      environment: input.environment,
    });
    providers[target] = provider;
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

function parseSourceRepository(
  row: Readonly<Record<string, unknown>>,
  target: string
): string {
  if (typeof row.source_repo !== "string") {
    throw new Error(
      `[deployment-targets] Off-cluster target ${target} requires source_repo`
    );
  }
  const match = row.source_repo.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (!match) {
    throw new Error(
      `[deployment-targets] Off-cluster target ${target} has invalid source_repo`
    );
  }
  return `${match[1]}/${match[2]}`.toLowerCase();
}
