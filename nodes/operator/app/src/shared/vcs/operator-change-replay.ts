// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Canonical operation replay shared by the zero-install CI bundle and the
 * deployed operator. Transports supply immutable file reads; every semantic
 * decision and byte comparison lives here.
 */

import { createHash } from "node:crypto";
import {
  type OperatorChangeIntent,
  OperatorChangeIntentSchema,
} from "@cogni/node-contracts";
import { renderDeploymentActivationSpec } from "@cogni/repo-spec";
import { parse as parseYaml } from "yaml";

import {
  appsetsKustomizationPath,
  buildEnvDeltaPlan,
  buildNodeBirthPlan,
  buildPlacementPlan,
  buildRegionPlan,
  CANONICAL_DOMAIN_ROOT,
  type EnvPlanCurrent,
  type EnvPlanOp,
  NODE_DEPLOY_ENVS,
  NODE_FORMATION_ENVS,
  type NodeFormationEnv,
  nextFreeNodePort,
  parseCatalogPlacement,
  planEnvAddShape,
  removeCaddyBlock,
  removeFromAppsetsKustomization,
  removeSchedulerEndpoint,
  schedulerEndpointPatchPath,
} from "@/shared/node-app-scaffold/gens";
import {
  controlEnvFor,
  nodeAppBaseUrl,
} from "@/shared/node-registry/placement";

const SHA = /^[0-9a-f]{40}$/;
const NODE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  /** Current protected parent-main catalog row; required only for deployment.declare. */
  readonly deploymentCatalog?: string | null;
  readonly fleetControlEnv?: string | undefined;
  readonly forkDomainRoot?: string | undefined;
  readonly reader: OperatorChangeReplayReader;
}

export interface OperatorChangeReplayResult {
  readonly verified: boolean;
  readonly reason: string;
}

export interface OperatorChangePlanInput {
  readonly intent: OperatorChangeIntent;
  readonly baseSha: string;
  readonly repository: string;
  readonly deploymentCatalog?: string | null;
  readonly fleetControlEnv?: string | undefined;
  readonly forkDomainRoot?: string | undefined;
  readonly reader: OperatorChangeReplayReader;
}

export type OperatorChangePlanResult =
  | {
      readonly status: "changes";
      readonly ops: readonly EnvPlanOp[];
      readonly intent: OperatorChangeIntent;
    }
  | { readonly status: "satisfied"; readonly intent: OperatorChangeIntent }
  | { readonly status: "conflict"; readonly reason: string };

export function parseOperatorChangeIntent(
  input: Pick<
    OperatorChangeReplayInput,
    "operation" | "node" | "baseSha" | "headSha" | "message"
  >
): OperatorChangeIntent {
  if (
    !NODE.test(input.node) ||
    !SHA.test(input.baseSha) ||
    !SHA.test(input.headSha)
  ) {
    throw new Error("invalid-identity");
  }
  const envelope = parseTrailers(input.message);
  if (
    envelope.get("Cogni-Change-Type") !== "cogni.operator-change.v1" ||
    envelope.get("Cogni-Operation") !== input.operation ||
    envelope.get("Cogni-Node") !== input.node ||
    envelope.get("Cogni-Base-SHA") !== input.baseSha
  ) {
    throw new Error("canonical-envelope-mismatch");
  }
  const recoveryRoot = envelope.get("Cogni-Recovery-Root-SHA");
  const recoveryDepthText = envelope.get("Cogni-Recovery-Depth");
  const recoveryLosingHead = envelope.get("Cogni-Recovery-Losing-Head-SHA");
  if (
    new Set([
      recoveryRoot === undefined,
      recoveryDepthText === undefined,
      recoveryLosingHead === undefined,
    ]).size !== 1
  ) {
    throw new Error("partial-recovery-envelope");
  }
  const recoveryDepth =
    recoveryDepthText === undefined ? 0 : Number(recoveryDepthText);
  const recoveryRootSha = recoveryRoot ?? input.headSha;
  if (
    !SHA.test(recoveryRootSha) ||
    (recoveryLosingHead !== undefined && !SHA.test(recoveryLosingHead)) ||
    !Number.isSafeInteger(recoveryDepth) ||
    recoveryDepth < 0 ||
    recoveryDepth > 3 ||
    (recoveryRoot !== undefined && recoveryDepth === 0)
  ) {
    throw new Error("invalid-recovery-envelope");
  }
  const extra = recoveryRoot === undefined ? 0 : 3;
  const subject = input.message.split("\n", 1)[0] ?? "";
  const common = { node: input.node, recoveryRootSha, recoveryDepth } as const;
  let candidate: unknown;
  switch (input.operation) {
    case "env.membership": {
      requireTrailerCount(envelope, 8 + extra);
      const environment = requiredEnvironment(envelope);
      const action = requiredTrailer(envelope, "Cogni-Action");
      if (!/^(add|remove)$/.test(action)) throw new Error("invalid-action");
      if (
        subject !==
        `feat(node): ${action} ${input.node} ${action === "add" ? "to" : "from"} ${environment}`
      ) {
        throw new Error("invalid-subject");
      }
      candidate = {
        ...common,
        operation: "env.membership",
        environment,
        action,
        leaseGeneration: requiredGeneration(envelope),
      };
      break;
    }
    case "env.placement": {
      requireTrailerCount(envelope, 7 + extra);
      const environment = requiredEnvironment(envelope);
      const provider = requiredTrailer(envelope, "Cogni-Provider");
      if (
        !/^(k3s|akash)$/.test(provider) ||
        subject !==
          `feat(node): place ${input.node} ${environment} on ${provider}`
      ) {
        throw new Error("invalid-placement-envelope");
      }
      candidate = {
        ...common,
        operation: "env.placement",
        environment,
        provider,
      };
      break;
    }
    case "env.region": {
      requireTrailerCount(envelope, 8 + extra);
      const environment = requiredEnvironment(envelope);
      const countries = requiredTrailer(envelope, "Cogni-Countries").split(",");
      if (
        countries.length === 0 ||
        countries.some((country) => !/^[A-Z]{2}$/.test(country)) ||
        uniqueSorted(countries).join(",") !== countries.join(",")
      ) {
        throw new Error("invalid-countries");
      }
      if (
        subject !==
        `feat(node): require ${input.node} ${environment} placement in ${countries.join(", ")}`
      ) {
        throw new Error("invalid-subject");
      }
      candidate = {
        ...common,
        operation: "env.region",
        environment,
        countries,
        leaseGeneration: requiredGeneration(envelope),
      };
      break;
    }
    case "node.register": {
      requireTrailerCount(envelope, 9 + extra);
      if (subject !== `feat(node): register ${input.node}`)
        throw new Error("invalid-subject");
      candidate = {
        ...common,
        operation: "node.register",
        nodeId: requiredTrailer(envelope, "Cogni-Node-Id"),
        sourceRepo: requiredTrailer(envelope, "Cogni-Source-Repo"),
        sourceSha: requiredTrailer(envelope, "Cogni-Source-SHA"),
        ownerWallet: requiredTrailer(envelope, "Cogni-Owner-Wallet"),
      };
      break;
    }
    case "deployment.declare":
      requireTrailerCount(envelope, 5 + extra);
      if (subject !== `feat(deploy): declare ${input.node} node deployment`)
        throw new Error("invalid-subject");
      candidate = { ...common, operation: "deployment.declare" };
      break;
    default:
      throw new Error("operation-not-bundled");
  }
  return OperatorChangeIntentSchema.parse(candidate);
}

export async function replayOperatorChange(
  input: OperatorChangeReplayInput
): Promise<OperatorChangeReplayResult> {
  try {
    const intent = parseOperatorChangeIntent(input);
    const envelope = parseTrailers(input.message);
    const sortedPaths = uniqueSorted(input.paths);
    if (sortedPaths.length !== input.paths.length)
      return failed("duplicate-path");
    const signedPathHash = envelope.get("Cogni-Changed-Paths-SHA256");
    const actualPathHash = createHash("sha256")
      .update(`${sortedPaths.join("\n")}\n`)
      .digest("hex");
    if (signedPathHash !== actualPathHash) return failed("path-hash-mismatch");

    const plan = await planOperatorChangeIntent({
      intent,
      baseSha: input.baseSha,
      repository: input.repository,
      ...(input.deploymentCatalog === undefined
        ? {}
        : { deploymentCatalog: input.deploymentCatalog }),
      ...(input.fleetControlEnv === undefined
        ? {}
        : { fleetControlEnv: input.fleetControlEnv }),
      ...(input.forkDomainRoot === undefined
        ? {}
        : { forkDomainRoot: input.forkDomainRoot }),
      reader: input.reader,
    });
    if (plan.status !== "changes") {
      if (plan.status === "conflict")
        return failed(`replay-error:${plan.reason}`);
      return failed(
        input.operation === "deployment.declare"
          ? "replay-error:deployment-already-declared"
          : "replay-error:unexpected-no-changes"
      );
    }
    if (JSON.stringify(plan.intent) !== JSON.stringify(intent)) {
      return failed("intent-replay-mismatch");
    }
    return await verifyOps(input, plan.ops);
  } catch (error) {
    return failed(
      error instanceof Error ? `replay-error:${error.message}` : "replay-error"
    );
  }
}

export async function planOperatorChangeIntent(
  input: OperatorChangePlanInput
): Promise<OperatorChangePlanResult> {
  try {
    let ops: readonly EnvPlanOp[] | null;
    let effectiveIntent = input.intent;
    switch (input.intent.operation) {
      case "env.membership":
        ops = await planMembership({ ...input, intent: input.intent });
        break;
      case "env.placement":
        ops = await planPlacement({ ...input, intent: input.intent });
        break;
      case "env.region": {
        const region = await planRegion({ ...input, intent: input.intent });
        ops = region.ops;
        effectiveIntent = {
          ...input.intent,
          leaseGeneration: region.leaseGeneration,
        };
        break;
      }
      case "node.register": {
        const registration = await planNodeRegister({
          ...input,
          intent: input.intent,
        });
        if (registration.status !== "changes") return registration;
        ops = registration.ops;
        break;
      }
      case "deployment.declare":
        ops = await planDeploymentDeclare({ ...input, intent: input.intent });
        break;
    }
    return ops === null
      ? { status: "satisfied", intent: effectiveIntent }
      : { status: "changes", ops, intent: effectiveIntent };
  } catch (error) {
    return {
      status: "conflict",
      reason: error instanceof Error ? error.message : "planner-error",
    };
  }
}

async function planMembership(
  input: OperatorChangePlanInput & {
    readonly intent: Extract<
      OperatorChangeIntent,
      { operation: "env.membership" }
    >;
  }
): Promise<readonly EnvPlanOp[] | null> {
  const { environment: env, action, leaseGeneration } = input.intent;
  const present = action === "add";
  const catalog = await requiredFile(
    input.reader,
    input.baseSha,
    `infra/catalog/${input.intent.node}.yaml`
  );
  const current = await membershipCurrent(input, catalog, env, present);
  const plan = buildEnvDeltaPlan({
    slug: input.intent.node,
    env,
    present,
    current,
    leaseGeneration,
    fleetControlEnv: input.fleetControlEnv,
  });
  return plan.kind === "no_changes" ? null : plan.ops;
}

async function planPlacement(
  input: OperatorChangePlanInput & {
    readonly intent: Extract<
      OperatorChangeIntent,
      { operation: "env.placement" }
    >;
  }
): Promise<readonly EnvPlanOp[] | null> {
  const { environment: env, provider } = input.intent;
  const plan = buildPlacementPlan({
    slug: input.intent.node,
    env,
    placement: provider as "k3s" | "akash",
    current: {
      catalog: await requiredFile(
        input.reader,
        input.baseSha,
        `infra/catalog/${input.intent.node}.yaml`
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
    },
  });
  return plan.kind === "no_changes" ? null : plan.ops;
}

async function planRegion(
  input: OperatorChangePlanInput & {
    readonly intent: Extract<OperatorChangeIntent, { operation: "env.region" }>;
  }
): Promise<{
  readonly ops: readonly EnvPlanOp[] | null;
  readonly leaseGeneration: number;
}> {
  const { environment: env, countries, leaseGeneration } = input.intent;
  const plan = buildRegionPlan({
    slug: input.intent.node,
    env,
    countries,
    leaseGeneration,
    current: {
      catalog: await requiredFile(
        input.reader,
        input.baseSha,
        `infra/catalog/${input.intent.node}.yaml`
      ),
      templateOverlayByEnv: {},
      appsetsKustomizationByEnv: {},
    },
  });
  return {
    ops: plan.kind === "no_changes" ? null : plan.ops,
    leaseGeneration:
      plan.kind === "no_changes" ? leaseGeneration : plan.leaseGeneration,
  };
}

async function planNodeRegister(
  input: OperatorChangePlanInput & {
    readonly intent: Extract<
      OperatorChangeIntent,
      { operation: "node.register" }
    >;
  }
): Promise<OperatorChangePlanResult> {
  const { node, nodeId, sourceRepo, sourceSha, ownerWallet } = input.intent;
  const repositoryOwner = input.repository.split("/", 1)[0];
  if (
    !repositoryOwner ||
    sourceRepo.toLowerCase() !==
      `https://github.com/${repositoryOwner}/${node}.git`.toLowerCase()
  ) {
    return { status: "conflict", reason: "node-register-source-repo-mismatch" };
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
  const controlEnvForBirth = (env: NodeFormationEnv) =>
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
  const catalogPath = `infra/catalog/${node}.yaml`;
  const existingCatalog = await input.reader.readFile(
    input.baseSha,
    catalogPath
  );
  let nodePort = nextFreeNodePort(usedPorts);
  if (existingCatalog !== null) {
    const row = parseYaml(existingCatalog) as Record<string, unknown> | null;
    if (
      row?.name !== node ||
      row.node_id !== nodeId ||
      typeof row.source_repo !== "string" ||
      row.source_repo.toLowerCase() !== sourceRepo.toLowerCase() ||
      row.source_sha !== sourceSha ||
      row.owner_wallet !== ownerWallet ||
      row.port !== 3200 ||
      !Number.isSafeInteger(row.node_port)
    ) {
      return { status: "conflict", reason: "node-register-identity-conflict" };
    }
    nodePort = row.node_port as number;
  }
  const appsetTemplate = await requiredFile(
    input.reader,
    input.baseSha,
    "scripts/ci/node-applicationset.yaml.tmpl"
  );
  const caddyfile = await requiredFile(
    input.reader,
    input.baseSha,
    "infra/compose/edge/configs/Caddyfile.tmpl"
  );
  const replayAppsets = { ...appsetsKustomizationByControlEnv };
  const replayScheduler = { ...schedulerEndpointByPath };
  let replayCaddyfile = caddyfile;
  if (existingCatalog !== null) {
    for (const env of NODE_FORMATION_ENVS) {
      const controlEnv = controlEnvForBirth(env);
      const current = replayAppsets[controlEnv];
      if (current === undefined) {
        throw new Error(`node-register-appset-missing:${controlEnv}`);
      }
      const absent = removeFromAppsetsKustomization(current, node, env);
      if (absent === current) {
        throw new Error(`node-register-appset-entry-missing:${env}:${node}`);
      }
      replayAppsets[controlEnv] = absent;
    }
    replayCaddyfile = removeCaddyBlock(caddyfile, node, nodePort);
    for (const [path, current] of Object.entries(replayScheduler)) {
      const patchEnv = path.match(
        /^infra\/k8s\/overlays\/([^/]+)\/scheduler-worker\/node-endpoints\.patch\.yaml$/
      )?.[1];
      const expectedUrl =
        patchEnv !== undefined &&
        (NODE_FORMATION_ENVS as readonly string[]).includes(patchEnv)
          ? nodeAppBaseUrl({
              slug: node,
              provider: "akash",
              environment: patchEnv as NodeFormationEnv,
              apexDomain: CANONICAL_DOMAIN_ROOT,
            })
          : `http://${node}-node-app:3000`;
      replayScheduler[path] = removeSchedulerEndpoint(
        current,
        node,
        nodeId,
        expectedUrl
      );
    }
  }
  const ops = buildNodeBirthPlan({
    slug: node,
    nodeId,
    sourceRepo,
    sourceSha,
    ownerWallet,
    port: 3200,
    nodePort,
    repositoryUrl: `https://github.com/${input.repository}.git`,
    controlEnvFor: controlEnvForBirth,
    current: {
      templateOverlayByEnv,
      templateExternalSecretByEnv,
      appsetTemplate,
      appsetsKustomizationByControlEnv: replayAppsets,
      caddyfile: replayCaddyfile,
      schedulerEndpointByPath: replayScheduler,
    },
  });
  for (const op of ops) {
    const nodeOwned =
      op.path === catalogPath ||
      op.path.includes(`/${node}/`) ||
      op.path.endsWith(`-${node}-applicationset.yaml`);
    if (
      nodeOwned &&
      existingCatalog === null &&
      (await input.reader.readFile(input.baseSha, op.path)) !== null
    ) {
      return { status: "conflict", reason: `node-path-collision:${op.path}` };
    }
  }
  if (existingCatalog !== null) {
    for (const op of ops) {
      const current = await input.reader.readFile(input.baseSha, op.path);
      if (op.op === "delete" ? current !== null : current !== op.content) {
        return {
          status: "conflict",
          reason: `node-register-footprint-conflict:${op.path}`,
        };
      }
    }
    return { status: "satisfied", intent: input.intent };
  }
  return { status: "changes", ops, intent: input.intent };
}

async function planDeploymentDeclare(
  input: OperatorChangePlanInput & {
    readonly intent: Extract<
      OperatorChangeIntent,
      { operation: "deployment.declare" }
    >;
  }
): Promise<readonly EnvPlanOp[] | null> {
  if (
    input.deploymentCatalog === undefined ||
    input.deploymentCatalog === null
  ) {
    throw new Error("deployment-parent-catalog-missing");
  }
  const parsedCatalog = parseYaml(input.deploymentCatalog) as unknown;
  if (
    parsedCatalog === null ||
    typeof parsedCatalog !== "object" ||
    Array.isArray(parsedCatalog)
  ) {
    throw new Error("deployment-parent-catalog-invalid");
  }
  const row = parsedCatalog as Record<string, unknown>;
  const expectedSourceRepo = `https://github.com/${input.repository}.git`;
  if (
    row.name !== input.intent.node ||
    typeof row.source_repo !== "string" ||
    row.source_repo.toLowerCase() !== expectedSourceRepo.toLowerCase()
  ) {
    throw new Error("deployment-parent-catalog-mismatch");
  }
  const path = ".cogni/repo-spec.yaml";
  const base = await requiredFile(input.reader, input.baseSha, path);
  if (/^deployment:/m.test(base)) return null;
  return [
    {
      op: "upsert",
      path,
      content: renderDeploymentActivationSpec(base),
    },
  ];
}

async function membershipCurrent(
  input: OperatorChangePlanInput,
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
      if (base === null || head !== null)
        return failed(`delete-mismatch:${op.path}`);
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
