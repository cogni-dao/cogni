// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-deploy-lanes`
 * Purpose: Compose the existing recovery lanes even when fresh workload DNS authority is unavailable.
 * Scope: Dependency wiring; native clients and process lifecycle remain in node-deploy-sequencer.
 * Invariants: One binding for all lanes; invalid config grants no fresh HTTP or DNS effects.
 * Side-effects: Calls the supplied catalog reader and DNS factory only for a valid binding.
 * Links: node-deploy-sequencer.ts, hub effects-survive-runner-loss
 * @internal
 */

import { EdgeRouter, edgeHostRegexFor } from "@/features/node-deploy/edge";
import type { EnvLane } from "@/features/node-deploy/env-lanes";
import {
  NodeDeploySequencer,
  type SequencerDeps,
} from "@/features/node-deploy/sequencer";
import type { DnsRecordsPort } from "@/ports";
import {
  resolveWorkloadZoneBinding,
  type WorkloadZoneBinding,
  WorkloadZoneConfigError,
} from "@/shared/node-registry/fleet-ownership";

export async function composeNodeDeployLanes(input: {
  readonly fleetOwner: string | undefined;
  readonly zoneName: string | undefined;
  readonly lanes: readonly EnvLane[];
  readonly dnsRecordsFor: (
    binding: WorkloadZoneBinding
  ) => DnsRecordsPort | undefined;
  readonly nodeDeploySlugs: (
    environment: string,
    fleetOwner: string
  ) => Promise<readonly string[]>;
  readonly depsForLane: (
    lane: EnvLane
  ) => Omit<SequencerDeps, "edge" | "httpAdmissionRefusal">;
}) {
  let authority:
    | { readonly ok: true; readonly binding: WorkloadZoneBinding }
    | { readonly ok: false; readonly reason: WorkloadZoneConfigError["code"] };
  try {
    authority = { ok: true, binding: resolveWorkloadZoneBinding(input) };
  } catch (error) {
    if (!(error instanceof WorkloadZoneConfigError)) throw error;
    authority = { ok: false, reason: error.code };
  }
  const resolved = authority;
  const dns = resolved.ok ? input.dnsRecordsFor(resolved.binding) : undefined;
  const lanes = await Promise.all(
    input.lanes.map(async (lane) => {
      const deps = input.depsForLane(lane);
      const edgeHostRegex =
        resolved.ok && dns
          ? edgeHostRegexFor(
              await input.nodeDeploySlugs(
                lane.environment,
                resolved.binding.fleetOwner
              ),
              resolved.binding
            )
          : undefined;
      const edge =
        resolved.ok && dns && edgeHostRegex
          ? new EdgeRouter(dns, resolved.binding, edgeHostRegex)
          : undefined;
      deps.log.info(
        {
          environment: lane.environment,
          secretsNamespace: lane.secretsNamespace,
          substrateHost: lane.substrateHost,
          fleetOwner: resolved.ok
            ? resolved.binding.fleetOwner
            : input.fleetOwner,
          edgeHostRegex: edgeHostRegex?.toString(),
        },
        "node_deploy_sequencer_edge_hosts"
      );
      return {
        environment: lane.environment,
        sequencer: new NodeDeploySequencer({
          ...deps,
          edge,
          ...(!resolved.ok ? { httpAdmissionRefusal: resolved.reason } : {}),
        }),
      };
    })
  );
  return { authority: resolved, edgeConfigured: Boolean(dns), lanes };
}
