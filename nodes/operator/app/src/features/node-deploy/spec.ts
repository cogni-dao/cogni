// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/spec`
 * Purpose: Lower a declared `NodeWorkloadSpec` to the actuator v1 wire spec, and read endpoints back
 *   (task.5400).
 * Scope: Pure.
 * Invariants:
 *   - ONE_SERVICE_PER_LEASE: a lease carries exactly one service; state and app never share one.
 *   - APP_EXPOSE_80: an http app exposes its port as 80, global, accepting only its public host.
 *   - STATE_FORWARDS_TCP: a state service exposes its port as itself, global (provider forwards it).
 *   - NO_PLACEMENT: no `placement` is sent; the canary takes the actuator's default screening.
 * Side-effects: none
 * @internal
 */

import type { NodeWorkloadSpec, PayerSpec } from "@/ports";

export function publicHostOf(w: NodeWorkloadSpec): string | undefined {
  return "http" in w.expose ? w.expose.http.host : undefined;
}

export function toPayerSpec(
  w: NodeWorkloadSpec,
  injectedEnv: Readonly<Record<string, string>>
): PayerSpec {
  const host = publicHostOf(w);
  return {
    name: w.name,
    services: [
      {
        name: w.name,
        image: w.image,
        env: { ...w.env, ...injectedEnv },
        ...(w.command ? { command: w.command } : {}),
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
