#!/usr/bin/env tsx

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/seed-doltgres`
 * Purpose: Seed Doltgres knowledge databases from per-node knowledge packages.
 * Scope: Reads DOLTGRES_URL, imports seeds from node packages, upserts + commits. Does not create schema or roles (provision script handles that).
 * Invariants: Idempotent (upsert). Independent read/write clients and the normal
 *   database writer scope own every seed commit. Requires packages:build first.
 * Side-effects: IO (database writes, console output)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import type { NewKnowledge } from "@cogni/knowledge-store";
import { createKnowledgeCapability } from "@cogni/knowledge-store";
import {
  buildDoltgresClient,
  DoltBranchSessionRunner,
  DoltgresKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";

const DOLTGRES_URL = process.env.DOLTGRES_URL;

if (!DOLTGRES_URL) {
  console.log("⏭️  DOLTGRES_URL not set — skipping knowledge seed");
  process.exit(0);
}

console.log("🌱 Seeding Doltgres knowledge store...");

const client = buildDoltgresClient({
  connectionString: DOLTGRES_URL,
  applicationName: "cogni_knowledge_seed",
});

const writerClient = buildDoltgresClient({
  connectionString: DOLTGRES_URL,
  applicationName: "cogni_knowledge_seed_writer",
  max: 1,
});
const writerSession = new DoltBranchSessionRunner(writerClient, {
  writerProtocol: "database",
});
const adapter = new DoltgresKnowledgeStoreAdapter({
  sql: client,
  writerSession,
});
const capability = createKnowledgeCapability(adapter);

// Load seeds — base domains + base knowledge from the shared knowledge-base package.
// Domains MUST be registered before knowledge writes: `write()` calls
// assertDomainRegistered and throws DomainNotRegisteredError otherwise. This is
// why a fresh env 400s `domain 'infrastructure' not registered` — the domain
// registry is an FK gate and nothing here used to seed it.
const domainSeeds: { id: string; name: string; description?: string }[] = [];
const seeds: NewKnowledge[] = [];

try {
  const baseMod = await import("@cogni/knowledge-base");
  domainSeeds.push(...baseMod.BASE_DOMAIN_SEEDS);
  seeds.push(...baseMod.BASE_KNOWLEDGE_SEEDS);
} catch (e) {
  // Fail LOUD — a fresh env with no base seeds must not report green.
  console.error(
    `❌ Could not load @cogni/knowledge-base seeds: ${e instanceof Error ? e.message : String(e)}`
  );
  await Promise.all([client.end(), writerClient.end()]);
  process.exit(1);
}

let hardFailures = 0;

// 1) Register base domains (idempotent — DomainAlreadyRegisteredError is a no-op).
console.log(`   Registering ${domainSeeds.length} base domains...`);
for (const d of domainSeeds) {
  try {
    await adapter.registerDomain(d);
    console.log(`   ✅ domain ${d.id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      e instanceof Error &&
      (e.name === "DomainAlreadyRegisteredError" ||
        msg.toLowerCase().includes("already"))
    ) {
      console.log(`   ⏭️  domain ${d.id} (already registered)`);
    } else {
      console.error(`   ❌ domain ${d.id}: ${msg}`);
      hardFailures += 1;
    }
  }
}

// 2) Write base knowledge entries.
console.log(`   Upserting ${seeds.length} seed entries...`);
for (const seed of seeds) {
  try {
    await capability.write(seed);
    console.log(`   ✅ ${seed.id} (${seed.domain})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("nothing to commit")) {
      console.log(`   ⏭️  ${seed.id} (already committed)`);
    } else {
      console.error(`   ❌ ${seed.id}: ${msg}`);
      hardFailures += 1;
    }
  }
}

// A write acknowledges its commit before native branch cleanup finishes.
// Queue a settlement barrier before ending pools; it acquires and reconciles
// the native writer even though its callback does not issue domain DML.
// Never force-close an unsettled writer or report it as successful.
await writerSession.run("knowledge.seed.settle", async () => undefined, {
  awaitSettlement: true,
});
await Promise.all([client.end(), writerClient.end()]);

if (hardFailures > 0) {
  // Never let a provision report green with an empty/partial knowledge plane.
  console.error(
    `❌ Doltgres knowledge seed FAILED: ${hardFailures} hard error(s).`
  );
  process.exit(1);
}

console.log("✅ Doltgres knowledge seed complete.");
