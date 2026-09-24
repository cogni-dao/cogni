// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-sdl`
 * Purpose: Translate the provider-agnostic ProvisionSpec into an Akash SDL v2.0 manifest
 *   (YAML string) — the one place Akash's deployment language exists in the codebase.
 * Scope: Pure spec→SDL mapping (services, compute profiles, placement pricing, exposes).
 *   Does NOT talk to the network, pick providers, or manage bids/leases (adapter's job).
 * Invariants:
 *   - PROVIDER_AGNOSTIC boundary: SDL never escapes this dir — callers hand in ProvisionSpec,
 *     the adapter submits the rendered YAML, and only ProvisionOutput comes back.
 *   - INTERNAL_EXPOSE_IS_MESH: a non-global expose renders `to: [service: <sibling>]` for every
 *     sibling, so generic co-located app-tier services reach each other by service-name DNS.
 *     Exactly one service owns global ingress; stateful/shared infrastructure remains outside
 *     the v0 workload boundary.
 * Side-effects: none (pure)
 * Links: ProvisionSpec (@cogni/ai-tools), https://akash.network/docs (SDL reference),
 *   infra/akash/README.md (catalog-driven renderer is the vNext home; task.5044)
 * @internal
 */

import type { ProvisionSpec } from "@cogni/ai-tools";
import { stringify } from "yaml";

export interface AkashSdlOptions {
  /** Pricing denom for placement bids. Managed (Console) wallets escrow USD-backed uakt. */
  readonly pricingDenom: string;
  /** MAX price per block per service, in `pricingDenom` micro-units (a ceiling — providers bid below). */
  readonly pricingAmount: number;
  /**
   * Audit-anchor accounts for `placement.signedBy.allOf` — only providers whose attributes
   * every listed auditor signed may bid (on-chain audited-only screening; task.5051).
   * Empty/omitted → open placement (no anchor).
   */
  readonly auditors?: readonly string[];
}

const PLACEMENT = "dcloud";

/** Render a ProvisionSpec as an Akash SDL v2.0 YAML string. */
export function buildAkashSdl(
  spec: ProvisionSpec,
  opts: AkashSdlOptions
): string {
  const services: Record<string, unknown> = {};
  const computeProfiles: Record<string, unknown> = {};
  const pricing: Record<string, unknown> = {};
  const deployment: Record<string, unknown> = {};

  for (const svc of spec.services) {
    const siblings = spec.services
      .filter((s) => s.name !== svc.name)
      .map((s) => ({ service: s.name }));

    services[svc.name] = {
      image: svc.image,
      ...(svc.command ? { command: [...svc.command] } : {}),
      ...(svc.args ? { args: [...svc.args] } : {}),
      ...(svc.env
        ? { env: Object.entries(svc.env).map(([k, v]) => `${k}=${v}`) }
        : {}),
      ...(svc.expose && svc.expose.length > 0
        ? {
            expose: svc.expose.map((e) => ({
              port: e.port,
              as: e.as,
              ...(e.hosts && e.hosts.length > 0
                ? { accept: [...e.hosts] }
                : {}),
              to: e.global ? [{ global: true }] : siblings,
            })),
          }
        : {}),
    };

    computeProfiles[svc.name] = {
      resources: {
        cpu: { units: svc.cpuUnits },
        memory: { size: `${svc.memoryMi}Mi` },
        storage: [{ size: `${svc.storageMi}Mi` }],
      },
    };

    pricing[svc.name] = {
      denom: opts.pricingDenom,
      amount: opts.pricingAmount,
    };

    deployment[svc.name] = {
      [PLACEMENT]: { profile: svc.name, count: 1 },
    };
  }

  return stringify({
    version: "2.0",
    services,
    profiles: {
      compute: computeProfiles,
      placement: {
        [PLACEMENT]: {
          ...(opts.auditors && opts.auditors.length > 0
            ? { signedBy: { allOf: [...opts.auditors] } }
            : {}),
          pricing,
        },
      },
    },
    deployment,
  });
}
