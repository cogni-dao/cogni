// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/spec`
 * Purpose: Lower a declared `NodeWorkloadSpec` to the actuator v1 wire spec, and read endpoints back
 *   (task.5400).
 * Scope: Pure.
 * Invariants:
 *   - ONE_RELEASE_PER_LEASE: an app and its private stateless companions share one release; retained state stays separate.
 *   - APP_EXPOSE_80: an http app exposes its port as 80, global, accepting only its public host.
 *   - STATE_FORWARDS_TCP: a state service exposes its port as itself, global (provider forwards it).
 *   - PLACEMENT_IS_THE_NODES (story.5141): `placement` is sent ONLY when the release names a country
 *     set: the node's manifest set for the release env (`spec.placement`, read at `sourceSha`, so the
 *     release pins it, CD3), else, as a bridge until every node moves, its catalog row's
 *     `required_placement_countries[<env>]` (task.5405). A release with both is refused (one writer,
 *     CD4). With neither, the actuator's default screening.
 *   - INJECTED_ENV_WINS: platform-injected env overrides a same-named declared `env` key.
 *   - DB_CA_TRUST_FOR_NODE_APPS: a node app that receives a database DSN starts through the database CA
 *     trust wrapper (`databaseConsumerCommand`), exactly as the Crossplane lane started it.
 *   - MESH_COMPANIONS_ARE_OPERATOR_OWNED (task.5431, CD1): a mesh attempt's `cogni-mesh` and
 *     `cogni-substrate` services are appended by the sequencer; with them, a declared service with either
 *     name is refused, so a node can never stand in for, or shadow, the operator's companions.
 * Side-effects: none
 * @internal
 */

import type { NodeWorkloadSpec, PayerSpec } from "@/ports";
import { databaseConsumerCommand } from "@/shared/secrets/database-ca-command";

import {
  MESH_COMPANION_NAMES,
  type MeshCompanionService,
} from "./mesh-attempt";

export function publicHostOf(w: NodeWorkloadSpec): string | undefined {
  return "http" in w.expose ? w.expose.http.host : undefined;
}

export interface ToPayerSpecOptions {
  /** The release's manifest set, else catalog `required_placement_countries[<env>]`; empty or absent sends no `placement`. */
  readonly requiredCountryCodes?: readonly string[];
  /** True for a non-operator node app: it starts through the database CA trust wrapper. */
  readonly nodeApp?: boolean;
  readonly companionEnvs?:
    | Readonly<Record<string, Readonly<Record<string, string>>>>
    | undefined;
  /** A mesh attempt's two operator-owned companions (`meshCompanionServices`); absent = egress. */
  readonly meshCompanions?: readonly MeshCompanionService[] | undefined;
}

export function toPayerSpec(
  w: NodeWorkloadSpec,
  injectedEnv: Readonly<Record<string, string>>,
  options: ToPayerSpecOptions = {}
): PayerSpec {
  const host = publicHostOf(w);
  const env = { ...w.env, ...injectedEnv };
  const start = options.nodeApp
    ? databaseConsumerCommand({
        runtimeProfile: "cogni-node-app-v1",
        ...(w.command ? { command: w.command } : {}),
        secretRefs: Object.keys(env).map((key) => ({ key })),
      })
    : { ...(w.command ? { command: w.command } : {}) };
  const countries = options.requiredCountryCodes ?? [];
  const declared = [
    w.serviceName ?? w.name,
    ...(w.companions ?? []).map((c) => c.name),
  ];
  const shadow = options.meshCompanions?.length
    ? declared.find((n) => MESH_COMPANION_NAMES.has(n))
    : undefined;
  if (shadow)
    throw new Error(
      `service name ${shadow} is reserved for the operator mesh companions`
    );
  return {
    name: w.name,
    ...(countries.length > 0
      ? { placement: { requiredCountryCodes: countries } }
      : {}),
    services: [
      {
        name: w.serviceName ?? w.name,
        image: w.image,
        env,
        ...(start.command ? { command: start.command } : {}),
        ...("args" in start && start.args ? { args: start.args } : {}),
        cpuUnits: w.cpu,
        memoryMi: w.memoryMi,
        storageMi: w.storageMi,
        ...(w.persistent
          ? {
              volumes: [
                {
                  name: "data",
                  sizeMi: w.persistent.sizeMi,
                  mountPath: w.persistent.mountPath,
                  tier: "nvme" as const,
                },
              ],
            }
          : {}),
        expose: [
          host
            ? { port: w.port, as: 80, global: true, hosts: [host] }
            : { port: w.port, as: w.port, global: true },
        ],
      },
      ...(w.companions ?? []).map((c) => ({
        name: c.name,
        image: c.image,
        env: { ...c.env, ...options.companionEnvs?.[c.name] },
        ...(c.command ? { command: c.command } : {}),
        cpuUnits: c.cpu,
        memoryMi: c.memoryMi,
        storageMi: c.storageMi,
        expose: [{ port: c.port, as: c.port, global: false }],
      })),
      ...(options.meshCompanions ?? []),
    ],
  };
}

/**
 * The provider ingress hostname for an http app: the endpoint that is not the public host, not a
 * forwarded tcp/udp port, with any scheme stripped.
 */
export function ingressHostOf(
  endpoints: readonly string[],
  publicHost: string | undefined
): string | undefined {
  for (const raw of endpoints) {
    if (/^(tcp|udp):\/\//i.test(raw)) continue;
    const host = raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!host || host === publicHost) continue;
    return host;
  }
  return undefined;
}
