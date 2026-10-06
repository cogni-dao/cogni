// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Canonical operation replay shared by the zero-install CI bundle and the
 * deployed operator. Transports supply immutable file reads; every semantic
 * decision and byte comparison lives here.
 */

import { createHash } from "node:crypto";
import { renderDeploymentActivationSpec } from "@cogni/repo-spec";

import {
  appsetsKustomizationPath,
  buildEnvDeltaPlan,
  buildNodeBirthPlan,
  buildPlacementPlan,
  buildRegionPlan,
  type EnvPlanCurrent,
  type EnvPlanOp,
  nextFreeNodePort,
  NODE_DEPLOY_ENVS,
  NODE_FORMATION_ENVS,
  parseCatalogPlacement,
  planEnvAddShape,
  schedulerEndpointPatchPath,
} from "@/shared/node-app-scaffold/gens";
import { controlEnvFor } from "@/shared/node-registry/placement";

const SHA = /^[0-9a-f]{40}$/;
const NODE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OperatorChangeReplayReader {
  readFile(ref: string, path: string): Promise<string | null>;
  listPaths(ref: string, prefix: string): Promise<readonly string[]>;
}

export interface OperatorChangeReplayInput {
  readonly operation: string;
  readonly node: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly message: string;
  readonly paths: readonly string[];
  readonly repository: string;
  readonly fleetControlEnv?: string | undefined;
  readonly forkDomainRoot?: string | undefined;
  readonly reader: OperatorChangeReplayReader;
}

export interface OperatorChangeReplayResult {
  readonly verified: boolean;
  readonly reason: string;
}

export async function replayOperatorChange(
  input: OperatorChangeReplayInput
): Promise<OperatorChangeReplayResult> {
  try {
    if (
      !NODE.test(input.node) ||
      !SHA.test(input.baseSha) ||
      !SHA.test(input.headSha)
    ) {
      return failed("invalid-identity");
    }
    const envelope = parseTrailers(input.message);
    if (
      envelope.get("Cogni-Change-Type") !== "cogni.operator-change.v1" ||
      envelope.get("Cogni-Operation") !== input.operation ||
      envelope.get("Cogni-Node") !== input.node ||
      envelope.get("Cogni-Base-SHA") !== input.baseSha
    ) {
      return failed("canonical-envelope-mismatch");
    }
    const sortedPaths = uniqueSorted(input.paths);
    if (sortedPaths.length !== input.paths.length) return failed("duplicate-path");
    const signedPathHash = envelope.get("Cogni-Changed-Paths-SHA256");
    const actualPathHash = createHash("sha256")
      .update(`${sortedPaths.join("\n")}\n`)
      .digest("hex");
    if (signedPathHash !== actualPathHash) return failed("path-hash-mismatch");

    const subject = input.message.split("\n", 1)[0] ?? "";
    let ops: readonly EnvPlanOp[];
    switch (input.operation) {
      case "env.membership":
        ops = await replayMembership(input, envelope, subject);
        break;
      case "env.placement":
        ops = await replayPlacement(input, envelope, subject);
        break;
      case "env.region":
        ops = await replayRegion(input, envelope, subject);
        break;
      case "node.register":
        ops = await replayNodeRegister(input, envelope, subject);
        break;
      case "deployment.declare":
        ops = await replayDeploymentDeclare(input, envelope, subject);
        break;
      default:
        return failed("operation-not-bundled");
    }
    return await verifyOps(input, ops);
  } catch (error) {
    return failed(
      error instanceof Error ? `replay-error:${error.message}` : "replay-error"
    );
  }
}

async function replayMembership(
  input: OperatorChangeReplayInput,
  envelope: ReadonlyMap<string, string>,
  subject: string
): Promise<readonly EnvPlanOp[]> {
  requireTrailerCount(envelope, 8);
  const env = requiredEnvironment(envelope);
  const action = requiredTrailer(envelope, "Cogni-Action");
  const leaseGeneration = requiredGeneration(envelope);
  if (!/^(add|remove)$/.test(action)) throw new Error("invalid-action");
  if (
    subject !==
    `feat(node): ${action} ${input.node} ${action === "add" ? "to" : "from"} ${env}`
  ) {
    throw new Error("invalid-subject");
  }
  const present = action === "add";
  const catalog = await requiredFile(
    input.reader,
    input.baseSha,
    `infra/catalog/${input.node}.yaml`
  );
  const current = await membershipCurrent(input, catalog, env, present);
  const plan = buildEnvDeltaPlan({
    slug: input.node,
    env,
    present,
    current,
    leaseGeneration,
    fleetControlEnv: input.fleetControlEnv,
  });
  if (plan.kind === "no_changes") throw new Error("unexpected-no-changes");
  return plan.ops;
}

async function replayPlacement(
  input: OperatorChangeReplayInput,
  envelope: ReadonlyMap<string, string>,
  subject: string
): Promise<readonly EnvPlanOp[]> {
  requireTrailerCount(envelope, 7);
  const env = requiredEnvironment(envelope);
  const provider = requiredTrailer(envelope, "Cogni-Provider");
  if (!/^(k3s|akash)$/.test(provider)) throw new Error("invalid-provider");
  if (subject !== `feat(node): place ${input.node} ${env} on ${provider}`) {
    throw new Error("invalid-subject");
  }
  const plan = buildPlacementPlan({
    slug: input.node,
    env,
    placement: provider as "k3s" | "akash",
    current: {
      catalog: await requiredFile(
        input.reader,
        input.baseSha,
        `infra/catalog/${input.node}.yaml`
      ),
      templateOverlayByEnv: {},
      appsetsKustomizationByEnv: {},
      publicDomainRoot: input.forkDomainRoot,
      schedulerEndpointPatchByEnv: {
        [env]: await requiredFile(
          input.reader,
          input.baseSha,
          schedulerEndpointPatchPath(env)
        ),
    },
  });
  if (plan.kind === "no_changes") throw new Error("unexpected-no-changes");
  return plan.ops;
}

async function replayRegion(
  input: OperatorChangeReplayInput,
  envelope: ReadonlyMap<string, string>,
  subject: string
): Promise<readonly EnvPlanOp[]> {
  requireTrailerCount(envelope, 8);
  const env = requiredEnvironment(envelope);
  const countries = requiredTrailer(envelope, "Cogni-Countries").split(",");
  const canonicalCountries = uniqueSorted(countries);
  if (
    countries.length === 0 ||
    countries.some((country) => !/^[A-Z]{2}$/.test(country)) ||
    canonicalCountries.join(",") !== countries.join(",")
  ) {
    throw new Error("invalid-countries");
  }
  const leaseGeneration = requiredGeneration(envelope);
  if (
    subject !==
    `feat(node): require ${input.node} ${env} placement in ${countries.join(", ")}`
  ) {
    throw new Error("invalid-subject");
  }
  const plan = buildRegionPlan({
    slug: input.node,
    env,
    countries,
    leaseGeneration,
    current: {
      catalog: await requiredFile(
        input.reader,
        input.baseSha,
        `infra/catalog/${input.node}.yaml`
      ),
      templateOverlayByEnv: {},
      appsetsKustomizationByEnv: {},
    },
  });
  if (plan.kind === "no_changes" || plan.leaseGeneration !== leaseGeneration) {
    throw new Error("region-replay-mismatch");
  }
  return plan.ops;
}

async function replayNodeRegister(
  input: OperatorChangeReplayInput,
  envelope: ReadonlyMap<string, string>,
  subject: string
): Promise<readonly EnvPlanOp[]> {
  requireTrailerCount(envelope, 9);
  const nodeId = requiredTrailer(envelope, "Cogni-Node-Id");
  const sourceRepo = requiredTrailer(envelope, "Cogni-Source-Repo");
  const sourceSha = requiredTrailer(envelope, "Cogni-Source-SHA");
  const ownerWallet = requiredTrailer(envelope, "Cogni-Owner-Wallet");
  const repositoryOwner = input.repository.split("/", 1)[0];
  if (
    !UUID.test(nodeId) ||
    !SHA.test(sourceSha) ||
    !WALLET.test(ownerWallet) ||
    sourceRepo.toLowerCase() !==
      `https://github.com/${repositoryOwner}/${input.node}.git`.toLowerCase() ||
    subject !== `feat(node): register ${input.node}`
  ) {
    throw new Error("invalid-register-envelope");
  }

  const catalogPaths = await input.reader.listPaths(
    input.baseSha,
    "infra/catalog"
  );
  const usedPorts: number[] = [];
  for (const path of catalogPaths.filter((path) => path.endsWith(".yaml"))) {
    const content = await input.reader.readFile(input.baseSha, path);
    const port = content?.match(/^node_port:\s*(\d+)\s*$/m)?.[1];
    if (port) usedPorts.push(Number(port));
  }
  const controlEnvForBirth = (env: (typeof NODE_FORMATION_ENVS)[number]) =>
    controlEnvFor(env, "akash", input.fleetControlEnv);
  const templateOverlayByEnv: Record<string, string> = {};
  const templateExternalSecretByEnv: Record<string, string> = {};
  const appsetsKustomizationByControlEnv: Record<string, string> = {};
  for (const env of NODE_FORMATION_ENVS) {
    templateOverlayByEnv[env] = await requiredFile(
      input.reader,
      input.baseSha,
      `infra/k8s/overlays/${env}/node-template/kustomization.yaml`
    );
    templateExternalSecretByEnv[env] = await requiredFile(
      input.reader,
      input.baseSha,
      `infra/k8s/overlays/${env}/node-template/external-secret.yaml`
    );
    const controlEnv = controlEnvForBirth(env);
    appsetsKustomizationByControlEnv[controlEnv] ??= await requiredFile(
      input.reader,
      input.baseSha,
      appsetsKustomizationPath(controlEnv)
    );
  }
  const schedulerEndpointByPath: Record<string, string> = {};
  for (const path of [
    "infra/k8s/base/scheduler-worker/configmap.yaml",
    ...NODE_DEPLOY_ENVS.map(schedulerEndpointPatchPath),
  ]) {
    schedulerEndpointByPath[path] = await requiredFile(
      input.reader,
      input.baseSha,
      path
    );
  }
  const ops = buildNodeBirthPlan({
    slug: input.node,
    nodeId,
    sourceRepo,
    sourceSha,
    ownerWallet,
    port: 3200,
    nodePort: nextFreeNodePort(usedPorts),
    repositoryUrl: `https://github.com/${input.repository}.git`,
    controlEnvFor: controlEnvForBirth,
    current: {
      templateOverlayByEnv,
      templateExternalSecretByEnv,
      appsetTemplate: await requiredFile(
        input.reader,
        input.baseSha,
        "scripts/ci/node-applicationset.yaml.tmpl"
      ),
      appsetsKustomizationByControlEnv,
      caddyfile: await requiredFile(
        input.reader,
        input.baseSha,
        "infra/compose/edge/configs/Caddyfile.tmpl"
      ),
      schedulerEndpointByPath,
    },
  });
  for (const op of ops) {
    const nodeOwned =
      op.path === `infra/catalog/${input.node}.yaml` ||
      op.path.includes(`/${input.node}/`) ||
      op.path.endsWith(`-${input.node}-applicationset.yaml`);
    if (
      nodeOwned &&
      (await input.reader.readFile(input.baseSha, op.path)) !== null
    ) {
      throw new Error(`node-path-collision:${op.path}`);
    }
  }
  return ops;
}

async function replayDeploymentDeclare(
  input: OperatorChangeReplayInput,
  envelope: ReadonlyMap<string, string>,
  subject: string
): Promise<readonly EnvPlanOp[]> {
  requireTrailerCount(envelope, 5);
  if (subject !== `feat(deploy): declare ${input.node} node deployment`) {
    throw new Error("invalid-subject");
  }
  const path = ".cogni/repo-spec.yaml";
  const base = await requiredFile(input.reader, input.baseSha, path);
  if (/^deployment:/m.test(base)) throw new Error("deployment-already-declared");
  return [
    {
      op: "upsert",
      path,
      content: renderDeploymentActivationSpec(base),
    },
  ];
}

async function membershipCurrent(
  input: OperatorChangeReplayInput,
  catalog: string,
  env: "candidate-a" | "preview" | "production",
  present: boolean
): Promise<EnvPlanCurrent> {
  const templateOverlayByEnv: Record<string, string> = {};
  const templateExternalSecretByEnv: Record<string, string> = {};
  const appsetsKustomizationByEnv: Record<string, string> = {};
  const schedulerEndpointPatchByEnv: Record<string, string> = {};
  if (present) {
    const shape = planEnvAddShape(catalog, env, input.fleetControlEnv);
    templateOverlayByEnv[env] = await requiredFile(
      input.reader,
      input.baseSha,
      `infra/k8s/overlays/${env}/node-template/kustomization.yaml`
    );
    templateExternalSecretByEnv[env] = await requiredFile(
      input.reader,
      input.baseSha,
      `infra/k8s/overlays/${env}/node-template/external-secret.yaml`
    );
    appsetsKustomizationByEnv[shape.controlEnv] = await requiredFile(
      input.reader,
      input.baseSha,
      appsetsKustomizationPath(shape.controlEnv)
    );
    if (shape.placement === "akash") {
      schedulerEndpointPatchByEnv[env] = await requiredFile(
        input.reader,
        input.baseSha,
        schedulerEndpointPatchPath(env)
      );
    }
    const port = catalog.match(/^port:\s*(\d+)\s*$/m)?.[1];
    const nodePort = catalog.match(/^node_port:\s*(\d+)\s*$/m)?.[1];
    if (!port || !nodePort) throw new Error("catalog-ports-missing");
    return {
      catalog,
      templateOverlayByEnv,
      templateExternalSecretByEnv,
      appsetTemplate: await requiredFile(
        input.reader,
        input.baseSha,
        "scripts/ci/node-applicationset.yaml.tmpl"
      ),
      appsetRepoUrl: `https://github.com/${input.repository}.git`,
      publicDomainRoot: input.forkDomainRoot,
      appsetsKustomizationByEnv,
      port: Number(port),
      nodePort: Number(nodePort),
      schedulerEndpointPatchByEnv,
    };
  }
  const provider = parseCatalogPlacement(catalog)[env] ?? "k3s";
  const controlEnv = controlEnvFor(env, provider, input.fleetControlEnv);
  appsetsKustomizationByEnv[controlEnv] = await requiredFile(
    input.reader,
    input.baseSha,
    appsetsKustomizationPath(controlEnv)
  );
  if (provider === "akash") {
    schedulerEndpointPatchByEnv[env] = await requiredFile(
      input.reader,
      input.baseSha,
      schedulerEndpointPatchPath(env)
    );
  }
  return {
    catalog,
    templateOverlayByEnv,
    publicDomainRoot: input.forkDomainRoot,
    appsetsKustomizationByEnv,
    schedulerEndpointPatchByEnv,
  };
}

async function verifyOps(
  input: OperatorChangeReplayInput,
  planned: readonly EnvPlanOp[]
): Promise<OperatorChangeReplayResult> {
  const plannedPaths = uniqueSorted(planned.map((op) => op.path));
  if (
    plannedPaths.length !== planned.length ||
    JSON.stringify(plannedPaths) !== JSON.stringify(uniqueSorted(input.paths))
  ) {
    return failed("planned-paths-mismatch");
  }
  for (const op of planned) {
    const [base, head] = await Promise.all([
      input.reader.readFile(input.baseSha, op.path),
      input.reader.readFile(input.headSha, op.path),
    ]);
    if (op.op === "delete") {
      if (base === null || head !== null) return failed(`delete-mismatch:${op.path}`);
    } else if (head !== op.content) {
      return failed(`content-mismatch:${op.path}`);
    }
  }
  return { verified: true, reason: "verified" };
}

function parseTrailers(message: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const line of message.split("\n")) {
    if (!line.startsWith("Cogni-")) continue;
    const separator = line.indexOf(": ");
    if (separator < 1) throw new Error("invalid-trailer");
    const key = line.slice(0, separator);
    if (result.has(key)) throw new Error(`duplicate-trailer:${key}`);
    result.set(key, line.slice(separator + 2));
  }
  return result;
}

function requireTrailerCount(
  envelope: ReadonlyMap<string, string>,
  expected: number
): void {
  if (envelope.size !== expected) throw new Error("unexpected-trailer-count");
}

function requiredTrailer(
  envelope: ReadonlyMap<string, string>,
  key: string
): string {
  const value = envelope.get(key);
  if (!value) throw new Error(`missing-trailer:${key}`);
  return value;
}

function requiredEnvironment(
  envelope: ReadonlyMap<string, string>
): "candidate-a" | "preview" | "production" {
  const value = requiredTrailer(envelope, "Cogni-Environment");
  if (!/^(candidate-a|preview|production)$/.test(value)) {
    throw new Error("invalid-environment");
  }
  return value as "candidate-a" | "preview" | "production";
}

function requiredGeneration(envelope: ReadonlyMap<string, string>): number {
  const value = requiredTrailer(envelope, "Cogni-Lease-Generation");
  if (!/^\d+$/.test(value)) throw new Error("invalid-lease-generation");
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw new Error("invalid-lease-generation");
  }
  return generation;
}

async function requiredFile(
  reader: OperatorChangeReplayReader,
  ref: string,
  path: string
): Promise<string> {
  const value = await reader.readFile(ref, path);
  if (value === null) throw new Error(`missing-file:${path}`);
  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function failed(reason: string): OperatorChangeReplayResult {
  return { verified: false, reason };
}
