// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/node-deploy-bundle-seal.adapter.int`
 * Purpose: Prove source-wide bundle acceptance and immutable image/spec seals on real PostgreSQL.
 * Scope: Actual store, migrated tables and component DB clients; does not contact production.
 * Invariants: Concurrent environments accept one bundle; a failed seal cannot mix spec and image;
 *   committed acceptance survives a lost acknowledgement and a new store/connection.
 * Side-effects: IO (testcontainers PostgreSQL only)
 * Links: src/adapters/server/node-deploy/postgres-store.adapter.ts, bug.5568, subtask.5034
 * @internal
 */

import { randomUUID } from "node:crypto";
import type { Database } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";
import {
  type NodeWorkloadSpec,
  nodeServiceSpecSchema,
  nodeWorkloadSpecSchema,
} from "@cogni/repo-spec";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresNodeDeployStore } from "@/adapters/server/node-deploy/postgres-store.adapter";
import {
  nodeWorkloadDesired,
  nodeWorkloadReleases,
} from "@/shared/db/node-workloads";

const SOURCE = "a".repeat(40);
const REPOSITORY = "example/node";
const IMAGE_REPOSITORY = "ghcr.io/example/node";
const bundle = (hex: string) => `${IMAGE_REPOSITORY}@sha256:${hex.repeat(64)}`;
const services = [
  nodeServiceSpecSchema.parse({
    name: "app",
    port: 3000,
    visibility: "public",
    artifact: { name: "app" },
    resources: { cpu_units: 1, memory_mi: 256, storage_mi: 256 },
  }),
  nodeServiceSpecSchema.parse({
    name: "helper",
    port: 8181,
    visibility: "private",
    artifact: { name: "helper" },
    resources: { cpu_units: 0.25, memory_mi: 256, storage_mi: 256 },
  }),
];

function pendingSpec(): NodeWorkloadSpec {
  return nodeWorkloadSpecSchema.parse({
    kind: "app",
    name: "app",
    serviceName: "app",
    image: `${IMAGE_REPOSITORY}:sha-${SOURCE}`,
    imagePending: true,
    port: 3000,
    cpu: 1,
    memoryMi: 256,
    storageMi: 256,
    env: { HELPER_URL: "http://helper:8181" },
    bindings: [],
    exclusive: false,
    expose: { http: { host: "node.example" } },
    health: {
      ready: "/readyz",
      version: "/version",
      qualification: { path: "/qualification", timeoutMs: 20000 },
    },
    companions: [
      {
        name: "helper",
        image: `ghcr.io/example/node-helper:sha-${SOURCE}`,
        imagePending: true,
        port: 8181,
        ready: "/readyz",
        cpu: 0.25,
        memoryMi: 256,
        storageMi: 256,
        env: {},
        secretKeys: [],
      },
    ],
    artifactPlan: {
      repository: REPOSITORY,
      imageRepository: IMAGE_REPOSITORY,
      services,
    },
  });
}

function sealedSpec(identity: string, imageHex: string): NodeWorkloadSpec {
  // PostgreSQL JSON omits undefined keys. Build the exact persisted seal shape.
  const { imagePending: _pending, ...pending } = pendingSpec();
  const image = bundle(imageHex);
  const helper = `ghcr.io/example/node-helper@sha256:${imageHex.repeat(64)}`;
  return nodeWorkloadSpecSchema.parse({
    ...pending,
    image,
    companions: pending.companions?.map(({ imagePending: _pending, ...c }) => ({
      ...c,
      image: helper,
    })),
    artifactPlan: {
      ...pending.artifactPlan,
      bundleDigest: bundle(identity),
      selectedImages: { app: image, helper },
    },
  });
}

describe("PostgresNodeDeployStore bundle seal (Component)", () => {
  const seed = getSeedDb();
  const clients: Database[] = [];
  let nodeId: string;

  function openStore() {
    const url = process.env.DATABASE_SERVICE_URL;
    if (!url) throw new Error("component DATABASE_SERVICE_URL is required");
    const db = createServiceDbClient(url, {
      max: 1,
      applicationName: "component_bundle_seal",
    });
    clients.push(db);
    return { db, store: new PostgresNodeDeployStore(db) };
  }

  async function release(store: PostgresNodeDeployStore, env: string) {
    return (
      await store.recordRelease({
        nodeId,
        env,
        workload: "app",
        sourceSha: SOURCE,
        spec: pendingSpec(),
        createdBy: "component-bundle-seal",
      })
    ).release;
  }

  async function raw(id: string) {
    const [row] = await seed
      .select()
      .from(nodeWorkloadReleases)
      .where(eq(nodeWorkloadReleases.id, id));
    if (!row) throw new Error("missing release fixture");
    return row;
  }

  beforeEach(() => {
    nodeId = randomUUID();
  });
  afterEach(async () => {
    await Promise.all(
      clients.splice(0).map((db) => db.$client.end({ timeout: 5 }))
    );
    await seed
      .delete(nodeWorkloadDesired)
      .where(eq(nodeWorkloadDesired.nodeId, nodeId));
    await seed
      .delete(nodeWorkloadReleases)
      .where(eq(nodeWorkloadReleases.nodeId, nodeId));
  });

  it("serializes overlapping env acceptance and leaves the rejected release wholly unsealed", async () => {
    const a = openStore();
    const b = openStore();
    const preview = await release(a.store, "preview");
    const candidate = await release(b.store, "candidate-a");
    const specs = [sealedSpec("b", "c"), sealedSpec("d", "e")] as const;
    const [pidA] = await a.db.$client`select pg_backend_pid() as pid`;
    const [pidB] = await b.db.$client`select pg_backend_pid() as pid`;
    if (!pidA || !pidB) throw new Error("missing connection identity");
    let competing: ReturnType<typeof Promise.allSettled> | undefined;
    await seed.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${nodeId}/${REPOSITORY}/${SOURCE}`}, 0))`
      );
      competing = Promise.allSettled([
        a.store.pinResolvedBundle(preview.id, specs[0]),
        b.store.pinResolvedBundle(candidate.id, specs[1]),
      ]);
      // Observe both native sessions waiting on the source lock before releasing it.
      let waiting = 0;
      const deadline = Date.now() + 1000;
      while (waiting !== 2 && Date.now() < deadline) {
        const rows =
          await tx.execute(sql`select count(*)::int as waiting from pg_locks
          where pid in (${pidA.pid}, ${pidB.pid}) and locktype = 'advisory' and not granted`);
        waiting = Number(rows[0]?.waiting);
      }
      expect(waiting).toBe(2);
    });
    const results = await competing;
    if (!results) throw new Error("race was not started");
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const rows = await Promise.all([raw(preview.id), raw(candidate.id)]);
    const winners = rows.filter((r) => r.resolvedImage !== null);
    const losers = rows.filter((r) => r.resolvedImage === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0];
    const loser = losers[0];
    if (!winner || !loser) throw new Error("missing race result");
    const index = winner.id === preview.id ? 0 : 1;
    expect(winner.spec).toEqual(specs[index]);
    expect(winner.resolvedImage).toBe(specs[index]?.image);
    expect(loser.spec).toEqual(pendingSpec());
    expect(results[index]).toMatchObject({
      status: "fulfilled",
      value: { id: winner.id },
    });
    expect(results[1 - index]).toEqual({
      status: "fulfilled",
      value: undefined,
    });
    const accepted = specs[index]?.artifactPlan?.bundleDigest;
    expect(await a.store.acceptedBundle(preview)).toBe(accepted);
    expect(await b.store.acceptedBundle(candidate)).toBe(accepted);
    // The rejected environment can accept the winner's immutable bundle, never its losing set.
    await b.store.pinResolvedBundle(loser.id, specs[index]);
    expect((await raw(loser.id)).spec).toEqual(winner.spec);
  });

  it("keeps primary image and complete spec immutable under competing same-release seals", async () => {
    const a = openStore();
    const b = openStore();
    const recorded = await release(a.store, "preview");
    const first = sealedSpec("b", "c");
    await a.store.pinResolvedBundle(recorded.id, first);
    expect(
      await b.store.pinResolvedBundle(recorded.id, sealedSpec("d", "e"))
    ).toBeUndefined();
    // Even an inconsistent payload claiming the accepted bundle cannot replace an existing seal.
    const retry = await b.store.pinResolvedBundle(
      recorded.id,
      sealedSpec("b", "e")
    );
    expect(retry?.spec).toEqual(first);
    expect(await raw(recorded.id)).toMatchObject({
      spec: first,
      resolvedImage: first.image,
    });
  });

  it("reads committed acceptance after a lost acknowledgement and store/connection restart", async () => {
    const original = openStore();
    const recorded = await release(original.store, "preview");
    const accepted = sealedSpec("b", "c");
    // Fault after the actual transaction commits; no fake DB or claimed network-fault injection.
    const loseAcknowledgement = async () => {
      await original.store.pinResolvedBundle(recorded.id, accepted);
      throw new Error("lost seal acknowledgement");
    };
    await expect(loseAcknowledgement()).rejects.toThrow(
      "lost seal acknowledgement"
    );
    await original.db.$client.end({ timeout: 5 });
    clients.splice(clients.indexOf(original.db), 1);
    const restarted = openStore();
    expect(await restarted.store.getRelease(recorded.id)).toMatchObject({
      spec: accepted,
      resolvedImage: accepted.image,
    });
    const nextEnv = await release(restarted.store, "candidate-a");
    expect(await restarted.store.acceptedBundle(nextEnv)).toBe(bundle("b"));
    expect(
      await restarted.store.pinResolvedBundle(nextEnv.id, sealedSpec("d", "e"))
    ).toBeUndefined();
    expect(await raw(nextEnv.id)).toMatchObject({
      spec: pendingSpec(),
      resolvedImage: null,
    });
    await restarted.store.pinResolvedBundle(nextEnv.id, accepted);
    expect(await raw(nextEnv.id)).toMatchObject({
      spec: accepted,
      resolvedImage: accepted.image,
    });
  });
});
