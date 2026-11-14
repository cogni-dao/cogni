// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/scripts/test-live`
 * Purpose: Live integration test — creates and removes a test subdomain. Does NOT touch protected records.
 * Scope: Manual testing only. Does NOT run in CI.
 * Invariants: Only touches *.preview subdomains. Protected names (@, www) are blocked by helpers.
 * Side-effects: IO (creates/deletes DNS records on Cloudflare)
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @internal
 */

import {
  CloudflareAdapter,
  removeDnsRecord,
  upsertDnsRecord,
} from "../src/index.js";

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

const cf = new CloudflareAdapter({ apiToken: token, zoneId });

async function main() {
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("--- Existing DNS records ---");
  const records = await cf.getDnsRecords("cognidao", "org");
  for (const r of records) {
    // biome-ignore lint/suspicious/noConsole: CLI script
    console.log(r.type.padEnd(6), r.name.padEnd(35), r.value);
  }

  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("\n--- Creating test.preview.cognidao.org ---");
  const created = await upsertDnsRecord(cf, "cognidao.org", {
    name: "test.preview",
    type: "CNAME",
    value: "example.com",
    ttl: 300,
  });
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("Created:", created);

  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("\n--- Verifying ---");
  const found = await cf.findRecords("test.preview.cognidao.org", "CNAME");
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("Found:", found.length, "record(s)");

  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("\n--- Cleaning up ---");
  await removeDnsRecord(cf, "cognidao.org", "test.preview", "CNAME");
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("Removed test.preview.cognidao.org");

  const after = await cf.findRecords("test.preview.cognidao.org", "CNAME");
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("Records after cleanup:", after.length);
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log("\nDone. Production records untouched.");
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.error(err);
  process.exit(1);
});
