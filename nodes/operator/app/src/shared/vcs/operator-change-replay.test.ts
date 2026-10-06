// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderDeploymentActivationSpec } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import {
  appsetsKustomizationPath,
  buildEnvDeltaPlan,
  buildNodeBirthPlan,
  buildPlacementPlan,
  buildRegionPlan,
  type EnvPlanOp,
  nextFreeNodePort,
  NODE_DEPLOY_ENVS,
  NODE_FORMATION_ENVS,
  type NodeFormationEnv,
  planEnvAddShape,
  schedulerEndpointPatchPath,
} from "@/shared/node-app-scaffold/gens";
import { controlEnvFor } from "@/shared/node-registry/placement";
import {
  type OperatorChangeReplayInput,
  type OperatorChangeReplayReader,
  replayOperatorChange,
} from "./operator-change-replay";

const root = process.cwd();
const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);
const repository = "cogni-dao/cogni";

interface ReplayFixture {
  readonly input: OperatorChangeReplayInput;
  readonly base: Map<string, string | null>;
  readonly head: Map<string, string | null>;
}

const fixtureBuilders = [
  membershipFixture,
  membershipRemoveFixture,
  placementFixture,
  placementAkashFixture,
  regionFixture,
  nodeRegisterFixture,
  deploymentFixture,
] as const;

describe("replayOperatorChange", () => {
  it("replays every operation through the same canonical core", async () => {
    const fixtures = await Promise.all(fixtureBuilders.map((build) => build()));
    for (const fixture of fixtures) {
      await expect(replayOperatorChange(fixture.input)).resolves.toEqual({
        verified: true,
        reason: "verified",
      });
    }
  });

  it("rejects forged bytes, forged paths, and stale envelopes for every operation", async () => {
    for (const build of fixtureBuilders) {
      const bytes = await build();
      const changedPath = bytes.input.paths.find(
        (path) => bytes.head.get(path) !== null
      );
      if (!changedPath) throw new Error("fixture has no upsert path");
      bytes.head.set(changedPath, `${bytes.head.get(changedPath)}# forged\n`);
      await expect(replayOperatorChange(bytes.input)).resolves.toMatchObject({
        verified: false,
      });

      const paths = await build();
      const extraPaths = [...paths.input.paths, "README.md"];
      await expect(
        replayOperatorChange({
          ...paths.input,
          paths: extraPaths,
          message: paths.input.message.replace(
            /Cogni-Changed-Paths-SHA256: [0-9a-f]{64}/,
            `Cogni-Changed-Paths-SHA256: ${pathHash(extraPaths)}`
          ),
        })
      ).resolves.toMatchObject({
        verified: false,
        reason: "planned-paths-mismatch",
      });

      const stale = await build();
      await expect(
        replayOperatorChange({
          ...stale.input,
          message: stale.input.message.replace(baseSha, "c".repeat(40)),
        })
      ).resolves.toEqual({
        verified: false,
        reason: "canonical-envelope-mismatch",
      });
    }
  });

  it("rejects operation-specific semantic attacks", async () => {
    const removal = await membershipRemoveFixture();
    const deletedPath = removal.input.paths.find(
      (path) => removal.head.get(path) === null
    );
    if (!deletedPath)
      throw new Error("membership remove fixture has no delete");
    removal.head.set(deletedPath, "forged\n");
    await expect(replayOperatorChange(removal.input)).resolves.toEqual({
      verified: false,
      reason: `delete-mismatch:${deletedPath}`,
    });

    const placement = await placementFixture();
    await expect(
      replayOperatorChange({
        ...placement.input,
        message: placement.input.message.replace(
          "Cogni-Provider: k3s",
          "Cogni-Provider: akash"
        ),
      })
    ).resolves.toMatchObject({ verified: false });

    for (const countries of ["CA,CA", "US,CA"]) {
      const region = await regionFixture();
      await expect(
        replayOperatorChange({
          ...region.input,
          message: region.input.message
            .replace(
              "placement in US",
              `placement in ${countries.replace(",", ", ")}`
            )
            .replace("Cogni-Countries: US", `Cogni-Countries: ${countries}`),
        })
      ).resolves.toMatchObject({
        verified: false,
        reason: "replay-error:invalid-countries",
      });
    }

    const owner = await nodeRegisterFixture();
    await expect(
      replayOperatorChange({
        ...owner.input,
        message: owner.input.message.replace(
          `0x${"2".repeat(40)}`,
          `0x${"3".repeat(40)}`
        ),
      })
    ).resolves.toMatchObject({ verified: false });

    const collision = await nodeRegisterFixture();
    collision.base.set(
      `infra/catalog/${collision.input.node}.yaml`,
      "occupied\n"
    );
    await expect(replayOperatorChange(collision.input)).resolves.toMatchObject({
      verified: false,
      reason: `replay-error:node-path-collision:infra/catalog/${collision.input.node}.yaml`,
    });

    const declared = await deploymentFixture();
    declared.base.set(
      ".cogni/repo-spec.yaml",
      `${disk(".cogni/repo-spec.yaml")}\ndeployment:\n  status: active\n`
    );
    await expect(replayOperatorChange(declared.input)).resolves.toMatchObject({
      verified: false,
      reason: "replay-error:deployment-already-declared",
    });
  });
});

async function membershipFixture(): Promise<ReplayFixture> {
  const node = "node-template";
  const env = "preview" as const;
  const catalog = disk(`infra/catalog/${node}.yaml`);
  const shape = planEnvAddShape(catalog, env, "production");
  const plan = buildEnvDeltaPlan({
    slug: node,
    env,
    present: true,
    leaseGeneration: 0,
    fleetControlEnv: "production",
    current: {
      catalog,
      templateOverlayByEnv: {
        [env]: disk(
          `infra/k8s/overlays/${env}/node-template/kustomization.yaml`
        ),
      },
      templateExternalSecretByEnv: {
        [env]: disk(
          `infra/k8s/overlays/${env}/node-template/external-secret.yaml`
        ),
      },
      appsetTemplate: disk("scripts/ci/node-applicationset.yaml.tmpl"),
      appsetRepoUrl: `https://github.com/${repository}.git`,
      publicDomainRoot: "cognidao.org",
      appsetsKustomizationByEnv: {
        [shape.controlEnv]: disk(appsetsKustomizationPath(shape.controlEnv)),
      },
      port: 3200,
      nodePort: 30200,
      schedulerEndpointPatchByEnv:
        shape.placement === "akash"
          ? { [env]: disk(schedulerEndpointPatchPath(env)) }
          : {},
    },
  });
  if (plan.kind === "no_changes") throw new Error("membership fixture no-op");
  return fixture(
    "env.membership",
    node,
    `feat(node): add ${node} to ${env}`,
    plan.ops,
    { Environment: env, Action: "add", "Lease-Generation": 0 }
  );
}

async function membershipRemoveFixture(): Promise<ReplayFixture> {
  const node = "red";
  const env = "candidate-a" as const;
  const catalog = disk(`infra/catalog/${node}.yaml`);
  const plan = buildEnvDeltaPlan({
    slug: node,
    env,
    present: false,
    fleetControlEnv: "production",
    current: {
      catalog,
      templateOverlayByEnv: {},
      appsetsKustomizationByEnv: {
        production: disk(appsetsKustomizationPath("production")),
      },
      schedulerEndpointPatchByEnv: {
        [env]: disk(schedulerEndpointPatchPath(env)),
      },
    },
  });
  if (plan.kind === "no_changes") {
    throw new Error("membership remove fixture no-op");
  }
  return fixture(
    "env.membership",
    node,
    `feat(node): remove ${node} from ${env}`,
    plan.ops,
    { Environment: env, Action: "remove", "Lease-Generation": 0 }
  );
}

async function placementFixture(): Promise<ReplayFixture> {
  return placementVariant("k3s", disk("infra/catalog/node-template.yaml"));
}

async function placementAkashFixture(): Promise<ReplayFixture> {
  const path = "infra/catalog/node-template.yaml";
  const catalog = disk(path).replace(
    "deployment_provider:\n  production: akash",
    "deployment_provider:\n  production: k3s"
  );
  return placementVariant(
    "akash",
    catalog,
    new Map<string, string | null>([[path, catalog]])
  );
}

function placementVariant(
  provider: "k3s" | "akash",
  catalog: string,
  base = new Map<string, string | null>()
): ReplayFixture {
  const node = "node-template";
  const env = "production" as const;
  const plan = buildPlacementPlan({
    slug: node,
    env,
    placement: provider,
    current: {
      catalog,
      templateOverlayByEnv: {},
      appsetsKustomizationByEnv: {},
      publicDomainRoot: "cognidao.org",
      schedulerEndpointPatchByEnv: {
        [env]: disk(schedulerEndpointPatchPath(env)),
      },
    },
  });
  if (plan.kind === "no_changes") throw new Error("placement fixture no-op");
  return fixture(
    "env.placement",
    node,
    `feat(node): place ${node} ${env} on ${provider}`,
    plan.ops,
    { Environment: env, Provider: provider },
    base
  );
}

async function regionFixture(): Promise<ReplayFixture> {
  const node = "node-template";
  const env = "production" as const;
  const plan = buildRegionPlan({
    slug: node,
    env,
    countries: ["US"],
    leaseGeneration: 3,
    current: {
      catalog: disk(`infra/catalog/${node}.yaml`),
      templateOverlayByEnv: {},
      appsetsKustomizationByEnv: {},
    },
  });
  if (plan.kind === "no_changes") throw new Error("region fixture no-op");
  return fixture(
    "env.region",
    node,
    `feat(node): require ${node} ${env} placement in US`,
    plan.ops,
    {
      Environment: env,
      Countries: "US",
      "Lease-Generation": plan.leaseGeneration,
    }
  );
}

async function nodeRegisterFixture(): Promise<ReplayFixture> {
  const node = "zz-replay-fixture";
  const catalogPaths = readdirSync(join(root, "infra/catalog"))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => `infra/catalog/${name}`);
  const usedPorts = catalogPaths.flatMap((path) => {
    const value = disk(path).match(/^node_port:\s*(\d+)\s*$/m)?.[1];
    return value ? [Number(value)] : [];
  });
  const controlFor = (env: NodeFormationEnv) =>
    controlEnvFor(env, "akash", "production");
  const appsetsKustomizationByControlEnv: Record<string, string> = {};
  for (const env of NODE_FORMATION_ENVS) {
    const control = controlFor(env);
    appsetsKustomizationByControlEnv[control] ??= disk(
      appsetsKustomizationPath(control)
    );
  }
  const plan = buildNodeBirthPlan({
    slug: node,
    nodeId: "11111111-1111-4111-8111-111111111111",
    sourceRepo: `https://github.com/cogni-dao/${node}.git`,
    sourceSha: "1".repeat(40),
    ownerWallet: `0x${"2".repeat(40)}`,
    port: 3200,
    nodePort: nextFreeNodePort(usedPorts),
    repositoryUrl: `https://github.com/${repository}.git`,
    controlEnvFor: controlFor,
    current: {
      templateOverlayByEnv: Object.fromEntries(
        NODE_FORMATION_ENVS.map((env) => [
          env,
          disk(`infra/k8s/overlays/${env}/node-template/kustomization.yaml`),
        ])
      ),
      templateExternalSecretByEnv: Object.fromEntries(
        NODE_FORMATION_ENVS.map((env) => [
          env,
          disk(`infra/k8s/overlays/${env}/node-template/external-secret.yaml`),
        ])
      ),
      appsetTemplate: disk("scripts/ci/node-applicationset.yaml.tmpl"),
      appsetsKustomizationByControlEnv,
      caddyfile: disk("infra/compose/edge/configs/Caddyfile.tmpl"),
      schedulerEndpointByPath: Object.fromEntries(
        [
          "infra/k8s/base/scheduler-worker/configmap.yaml",
          ...NODE_DEPLOY_ENVS.map(schedulerEndpointPatchPath),
        ].map((path) => [path, disk(path)])
      ),
    },
  });
  return fixture("node.register", node, `feat(node): register ${node}`, plan, {
    "Node-Id": "11111111-1111-4111-8111-111111111111",
    "Source-Repo": `https://github.com/cogni-dao/${node}.git`,
    "Source-SHA": "1".repeat(40),
    "Owner-Wallet": `0x${"2".repeat(40)}`,
  });
}

async function deploymentFixture(): Promise<ReplayFixture> {
  const node = "cogni-template";
  const path = ".cogni/repo-spec.yaml";
  return fixture(
    "deployment.declare",
    node,
    `feat(deploy): declare ${node} node deployment`,
    [
      {
        op: "upsert",
        path,
        content: renderDeploymentActivationSpec(disk(path)),
      },
    ],
    {}
  );
}

function fixture(
  operation: string,
  node: string,
  subject: string,
  ops: readonly EnvPlanOp[],
  trailers: Readonly<Record<string, string | number>>,
  base = new Map<string, string | null>()
): ReplayFixture {
  const head = new Map<string, string | null>();
  for (const op of ops) {
    head.set(op.path, op.op === "delete" ? null : op.content);
  }
  const paths = ops.map((op) => op.path).sort();
  const reader = readerFor(base, head);
  return {
    base,
    head,
    input: {
      operation,
      node,
      baseSha,
      headSha,
      repository,
      paths,
      message: message(subject, operation, node, paths, trailers),
      fleetControlEnv: "production",
      forkDomainRoot: "cognidao.org",
      reader,
    },
  };
}

function readerFor(
  base: ReadonlyMap<string, string | null>,
  head: ReadonlyMap<string, string | null>
): OperatorChangeReplayReader {
  return {
    readFile: async (ref, path) => {
      if (ref === headSha && head.has(path)) return head.get(path) ?? null;
      if (ref === baseSha && base.has(path)) return base.get(path) ?? null;
      try {
        return disk(path);
      } catch {
        return null;
      }
    },
    listPaths: async (_ref, prefix) =>
      readdirSync(join(root, prefix)).map((name) => `${prefix}/${name}`),
  };
}

function message(
  subject: string,
  operation: string,
  node: string,
  paths: readonly string[],
  trailers: Readonly<Record<string, string | number>>
): string {
  return [
    subject,
    "",
    "Cogni-Change-Type: cogni.operator-change.v1",
    `Cogni-Operation: ${operation}`,
    `Cogni-Node: ${node}`,
    `Cogni-Base-SHA: ${baseSha}`,
    ...Object.entries(trailers).map(([key, value]) => `Cogni-${key}: ${value}`),
    `Cogni-Changed-Paths-SHA256: ${pathHash(paths)}`,
  ].join("\n");
}

function pathHash(paths: readonly string[]): string {
  return createHash("sha256")
    .update(`${[...paths].sort().join("\n")}\n`)
    .digest("hex");
}

function disk(path: string): string {
  return readFileSync(join(root, path), "utf8");
}
