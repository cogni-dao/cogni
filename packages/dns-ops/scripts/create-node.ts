// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/scripts/create-node`
 * Purpose: Node creation wizard — provisions DNS subdomain and generates node-spec fragment. Does NOT touch protected records.
 * Scope: Prototype CLI for multi-node formation. Does NOT provision DB or containers (v1).
 * Invariants: Only creates *.nodes subdomains. Protected names blocked by helpers.
 * Side-effects: IO (Cloudflare DNS API, stdout)
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @internal
 */

import { randomUUID } from "node:crypto";
import { CloudflareAdapter, upsertDnsRecord } from "../src/index.js";

// ── Config ──────────────────────────────────────────────────

const DOMAIN = "cognidao.org";
const NODES_SUBDOMAIN = "nodes"; // all nodes live under *.nodes.cognidao.org
// TODO: replace with actual cluster ingress IP when infra is provisioned
// biome-ignore lint/style/noProcessEnv: CLI script reads env directly
const CLUSTER_TARGET = process.env.CLUSTER_INGRESS_IP ?? "192.0.2.1"; // RFC 5737 TEST-NET placeholder

// ── Input ───────────────────────────────────────────────────

const slug = process.argv[2];
if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.error(
    "Usage: npx tsx packages/dns-ops/scripts/create-node.ts <slug>"
  );
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.error(
    "  slug: lowercase alphanumeric + hyphens (e.g., resy, music-dao)"
  );
  process.exit(1);
}

// biome-ignore lint/style/noProcessEnv: CLI script reads env directly
const token = process.env.CLOUDFLARE_API_TOKEN;
// biome-ignore lint/style/noProcessEnv: CLI script reads env directly
const zoneId = process.env.CLOUDFLARE_ZONE_ID;
if (!token || !zoneId) {
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.error(
    "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID in .env.local"
  );
  process.exit(1);
}

// ── Execute ─────────────────────────────────────────────────

async function main() {
  const cf = new CloudflareAdapter({ apiToken: token, zoneId });
  const nodeId = randomUUID();
  const shortId = nodeId.slice(0, 8);
  const fqdn = `${slug}.${NODES_SUBDOMAIN}.${DOMAIN}`;

  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`\n🔧 Creating node: ${slug}`);
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`   node_id:  ${nodeId}`);
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`   short_id: ${shortId}`);
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`   domain:   ${fqdn}`);

  // Step 1: Create DNS record
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`\n📡 Creating DNS record: ${fqdn} → ${CLUSTER_TARGET}`);
  const record = await upsertDnsRecord(cf, DOMAIN, {
    name: `${slug}.${NODES_SUBDOMAIN}`,
    type: "A",
    value: CLUSTER_TARGET,
    ttl: 300,
  });
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`   ✅ DNS record created (id: ${record.id})`);

  // Step 2: Generate node-spec fragment
  const nodeSpec = {
    node_id: nodeId,
    short_id: shortId,
    slug,
    domain: fqdn,
    url: `https://${fqdn}`,
    dns: {
      provider: "cloudflare",
      zone_id: zoneId,
      record_id: record.id,
      record_type: "A",
      record_value: CLUSTER_TARGET,
    },
    infra: {
      database_schema: `node_${slug.replace(/-/g, "_")}`,
      namespace: `node-${shortId}`,
      status: "dns_provisioned",
    },
    created_at: new Date().toISOString(),
  };

  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("\n📋 Node spec fragment:");
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("─".repeat(60));
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(JSON.stringify(nodeSpec, null, 2));
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("─".repeat(60));

  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`\n✅ Node "${slug}" created.`);
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`   Visit: https://${fqdn} (once cluster ingress is configured)`);
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`   Verify: dig ${fqdn} +short`);

  // Step 3: Verify DNS resolves
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`\n🔍 Verifying DNS...`);
  const found = await cf.findRecords(fqdn, "A");
  if (found.length > 0) {
    // biome-ignore lint/suspicious/noConsole: CLI script
    console.log(`   ✅ ${fqdn} → ${found[0]?.value}`);
  } else {
    // biome-ignore lint/suspicious/noConsole: CLI script
    console.log("   ⚠️  Record not found via API (may need propagation)");
  }
}

main().catch((e) => {
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.error(e);
  process.exit(1);
});
