// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/render-node-akash-sdl`
 * Purpose: Render a node's app-only Akash SDL for the crypto (human-signed) deploy rail.
 * Scope: Reusable/refinable template — reuses the SAME merged renderer the managed adapter
 *   uses (buildNodeWorkloadSpec + buildAkashSdl) so the crypto lease submits a byte-identical
 *   workload. Writes the SDL to a gitignored path (it embeds scoped connection secrets from the
 *   env bundle). Does NOT sign, deploy, or hold a key — the human signs the SDL in Keplr/Console Air.
 * Invariants: APP_ONLY (dials the shared Cherry substrate; infra sidecars on Akash are the rejected
 *   anti-pattern); SECRETS_STAY_GITIGNORED (env bundle + rendered SDL never committed); provider is
 *   load-bearing (accept only the allowlisted-egress provider, never cheapest/froggy).
 * Side-effects: IO (reads env bundle JSON, writes <slug>-akash.sdl.yaml)
 * Links: task.5049, task.5044, Dolt: akash-crypto-deploy-runbook
 * @internal — bring-up template, not for production use
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildNodeWorkloadSpec } from "../../nodes/operator/app/src/features/compute/node-workload-spec";
import { buildAkashSdl } from "../../nodes/operator/app/src/adapters/server/compute/akash-sdl";

interface NodeAkashPreset {
  readonly slug: string;
  readonly nodeId: string;
  readonly image: string;
  readonly port: number;
  readonly host: string;
  /** Gitignored JSON of the scoped connection env (DSNs to the Cherry substrate, AUTH_SECRET, LITELLM_*). */
  readonly envFile: string;
  /** Provider whose egress is firewall-allowlisted for the shared substrate — accept ONLY this bid. */
  readonly acceptProvider: string;
  /** Known-bad provider(s): underbid + fail image pulls. NEVER accept; never fall back to cheapest. */
  readonly rejectProviders: readonly string[];
  /** Production sizing. The renderer DEFAULT (0.5 vCPU/1024Mi) starves a Next.js SSR user endpoint
   *  (~2s /readyz). These are real user-facing sites — size for production. */
  readonly resources: { readonly cpuUnits: number; readonly memoryMi: number; readonly storageMi: number };
}

// Refine here as nodes move to the crypto rail. One preset per node.
const NODES: Record<string, NodeAkashPreset> = {
  toks4: {
    slug: "toks4",
    nodeId: "72aa130b-f0ad-495a-a061-9ee1f9c9525d",
    image: "ghcr.io/cogni-dao/toks4:sha-3979c40252f8a784ead2b9b5aaee46c2b1d11e20",
    port: 3200,
    host: "toks4-akash.cognidao.org",
    envFile: ".context/toks4-akash-env.json",
    acceptProvider: "akash16yr3wxt97ae045a06kr3ycde9srcgpg8syjxxm", // provider.zencloud.eu (audited)
    rejectProviders: ["akash1s3hq36mpas4nmkqasn7fgwhs9968cgl3u5esnw"], // froggy-servers (dud)
    resources: { cpuUnits: 2, memoryMi: 2048, storageMi: 4096 }, // production endpoint (was 0.5/1024/2048 → ~2s /readyz)
  },
};

// Max price ceiling per block (providers bid below). MUST be uact (ACT): current Akash
// mainnet denominates deployment escrow + leases in ACT, not AKT — a raw uakt SDL is
// rejected at deposit ("Deposit invalid"). The managed Console adapter gets away with uakt
// because its backend converts AKT->ACT server-side; the self-custody path submits the raw
// denom, so it must be uact. Ceiling is generous (providers bid ~3 uact/block); you pay the bid.
const PRICING = { pricingDenom: "uact", pricingAmount: 10000 } as const;

function main(): void {
  const slug = process.argv[2] ?? "toks4";
  const preset = NODES[slug];
  if (!preset) {
    throw new Error(
      `No Akash preset for "${slug}". Add one to NODES in this file. Known: ${Object.keys(NODES).join(", ")}`
    );
  }

  const env = JSON.parse(readFileSync(preset.envFile, "utf8")) as Record<string, string>;
  const spec = buildNodeWorkloadSpec({
    slug: preset.slug,
    nodeId: preset.nodeId,
    image: preset.image,
    port: preset.port,
    publicUrl: `https://${preset.host}`,
    hosts: [preset.host],
    env,
    resources: preset.resources,
  });
  const sdl = buildAkashSdl(spec, PRICING);

  const outPath = `.context/${preset.slug}-akash.sdl.yaml`;
  writeFileSync(outPath, sdl, { mode: 0o600 });

  process.stderr.write(
    [
      ``,
      `Rendered ${preset.slug} app-only SDL → ${outPath} (gitignored; embeds scoped secrets)`,
      ``,
      `Deploy via Console Air (your Keplr signs — no key ever leaves your wallet):`,
      `  1. Console Air → Deploy → upload ${outPath}`,
      `  2. Keplr signs the deployment`,
      `  3. ACCEPT ONLY provider ${preset.acceptProvider} (provider.zencloud.eu)`,
      `     NEVER the cheapest bid — that is ${preset.rejectProviders.join(", ")} (froggy, dud pulls)`,
      `  4. Keplr signs the lease → manifest → provider URL`,
      ``,
    ].join("\n")
  );
}

main();
