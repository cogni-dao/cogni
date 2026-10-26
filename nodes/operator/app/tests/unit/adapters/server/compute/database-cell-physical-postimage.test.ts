// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@tests/unit/adapters/server/compute/database-cell-physical-postimage`
 * Purpose: Falsify unreviewed physical-recovery configuration deltas using synthetic private preimages.
 * Scope: Pure adapter qualification; no DB, credentials, provider or runtime actions.
 * Invariants: Correctly rehashed bytes cannot authorize changed startup, env or containment.
 * Side-effects: none
 * Links: database-cell-physical-postimage.ts, subtask.5023
 * @internal
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PhysicalRecoveryArtifactSchema,
  qualifyPhysicalPostimages,
} from "@/adapters/server/compute/database-cell-physical-postimage";
import type { DatabaseCellAppliedCustody } from "@/types/database-cell";

function postimageFixture() {
  const now = new Date().toISOString();
  const sha = (value: string) => value.repeat(64);
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const NODE = "5f79c3ac-7fbe-4d0f-a599-e364fb203755";
  const sourceRecord = {
    cogniKey: "source",
    providerAccount: `akash1${"d".repeat(38)}`,
  };
  const targetRecord = { providerAccount: sourceRecord.providerAccount };
  const image = `postgres@sha256:${sha("1")}`;
  const original = {
    version: "2.0",
    services: {
      postgres: {
        image,
        command: ["bash"],
        args: ["/original-start.sh"],
        env: ["PGDATA=/var/lib/postgresql/data/pgdata"],
        params: {
          storage: {
            database: { mount: "/var/lib/postgresql/data", readOnly: false },
          },
        },
        expose: [{ port: 5432, as: 5432, global: true }],
      },
    },
    profiles: { resources: { cpu: 2, memory: 8, storage: 100 } },
  };
  const sourceHeld = structuredClone(original);
  sourceHeld.services.postgres.command = ["sleep"];
  sourceHeld.services.postgres.args = ["infinity"];
  sourceHeld.services.postgres.params.storage.database.readOnly = true;
  const cold = structuredClone(original);
  cold.services.postgres.command = ["sleep"];
  cold.services.postgres.args = ["infinity"];
  cold.services.postgres.env = ["PGDATA=/var/lib/postgresql/data/pgdata"];
  cold.profiles.resources = { cpu: 4, memory: 16, storage: 200 };
  const normal = { ...cold, services: original.services };
  const appOriginal = {
    services: {
      app: {
        image: `app@sha256:${sha("2")}`,
        command: ["node"],
        args: ["server.js"],
        env: [
          "DATABASE_URL=old-app",
          "DATABASE_SERVICE_URL=old-service",
          "KEEP=original",
        ],
      },
    },
  };
  const appHeld = structuredClone(appOriginal);
  appHeld.services.app.command = ["sleep"];
  appHeld.services.app.args = ["infinity"];
  appHeld.services.app.env = [
    "DATABASE_URL=new-app",
    "DATABASE_SERVICE_URL=new-service",
    "KEEP=original",
  ];
  const definitions = {
    sourceOriginal: JSON.stringify(original),
    sourceHeld: JSON.stringify(sourceHeld),
    targetCold: JSON.stringify(cold),
    targetNormal: JSON.stringify(normal),
    appOriginal: JSON.stringify(appOriginal),
    appHeld: JSON.stringify(appHeld),
  };
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const ledgerPreimages = {
    sourceOriginal: JSON.stringify(original, null, 2),
    targetCold: JSON.stringify(cold, null, 2),
    appOriginal: JSON.stringify(appOriginal, null, 2),
  };
  const ledgerHashes = {
    source: digest(ledgerPreimages.sourceOriginal),
    target: digest(ledgerPreimages.targetCold),
    app: digest(ledgerPreimages.appOriginal),
  };
  const startup = digest(
    JSON.stringify([
      original.services.postgres.command,
      original.services.postgres.args,
    ])
  );
  const evidence = {
    version: 1,
    observedAt: now,
    source: {
      cogniKey: sourceRecord.cogniKey,
      receiptId: id(1),
      dseq: "10001",
      providerAccount: sourceRecord.providerAccount,
      systemIdentifier: "1234567890",
      originalAppliedSdlHash: ledgerHashes.source,
      heldSdlHash: digest(definitions.sourceHeld),
      manifestVersion: Buffer.alloc(32, 1).toString("base64"),
      serviceName: "postgres",
      observedAt: now,
      postgresAbsent: true,
      mount: {
        path: "/var/lib/postgresql/data",
        device: "/dev/a",
        majorMinor: "8:1",
        readOnly: true,
      },
    },
    copy: {
      startedAt: now,
      completedAt: now,
      bytes: 100,
      files: 10,
      postgresMajor: 15,
      uid: 999,
      gid: 999,
      sourceManifestSha256: sha("1"),
      targetManifestSha256: sha("1"),
      sourceMetadataSha256: sha("2"),
      targetMetadataSha256: sha("2"),
      allTablespacesCovered: true,
      transportDrained: true,
      originalStartupSha256: startup,
      targetStartupSha256: startup,
    },
    target: {
      observedAt: now,
      dseq: "10002",
      providerAccount: targetRecord.providerAccount,
      originalAppliedSdlHash: ledgerHashes.target,
      preimageSdlHash: digest(definitions.targetCold),
      normalSdlHash: digest(definitions.targetNormal),
      manifestVersion: Buffer.alloc(32, 2).toString("base64"),
      volume: {
        path: "/var/lib/postgresql/data",
        device: "/dev/b",
        majorMinor: "8:2",
        totalBytes: 200000,
        usedBytes: 100000,
        availableBytes: 90000,
        totalInodes: 1000,
        availableInodes: 900,
      },
    },
    app: {
      originalAppliedSdlHash: ledgerHashes.app,
      preimageSdlHash: digest(definitions.appOriginal),
      heldSdlHash: digest(definitions.appHeld),
      manifestVersion: Buffer.alloc(32, 3).toString("base64"),
      observedAt: now,
      businessWritersAbsent: true,
    },
    reconciliation: {
      observedAt: now,
      xrUid: NODE,
      pausedResourceUids: [id(1), id(2)],
      acknowledgedPaused: true,
      providerOperationsSettled: true,
      custodyVersionsSha256: sha("3"),
      dnsRecordSha256: sha("4"),
      independentCustodianWatching: true,
    },
    preservedBackup: {
      receiptSha256: sha("5"),
      archiveSha256: sha("6"),
      bytes: 1000,
    },
  };
  const custody: DatabaseCellAppliedCustody = {
    version: 1,
    nodeId: NODE,
    nodeSlug: "fixture",
    environment: "production",
    manualProvenance: {
      kind: "manual-observed",
      postgresImageDigest: `sha256:${sha("1")}`,
      managedSdlSha256: sha("a"),
      qualificationArtifactSha256: sha("b"),
      qualifiedAt: now,
    },
    targetBuildSha: "a".repeat(40),
    canonicalEndpointHost: "db.fixture.invalid",
    databaseName: "cogni_fixture",
    appRole: "app_fixture",
    serviceRole: "service_fixture",
    budgetProfile: "shared-default-v1",
    budget: { kind: "preserved-role-bounds", roles: [] },
    tlsCertificate: "fixture-certificate",
    tls: { kind: "system" },
    app: {
      dsn: "new-app",
      custody: { service: "fixture", key: "DATABASE_URL" },
    },
    service: {
      dsn: "new-service",
      custody: { service: "fixture", key: "DATABASE_SERVICE_URL" },
    },
    migration: { kind: "app-database-url" },
  };
  return {
    artifact: PhysicalRecoveryArtifactSchema.parse({
      evidence,
      definitions,
      ledgerPreimages,
    }),
    ledgerHashes,
    custody,
    primaryServiceName: "postgres",
    appServiceName: "app",
  };
}
describe("private known physical postimages", () => {
  it("accepts only the fixed source hold, original target startup, and held consumer delta", () => {
    expect(() => qualifyPhysicalPostimages(postimageFixture())).not.toThrow();
    for (const field of ["sourceHeld", "targetNormal", "appHeld"] as const) {
      const input = postimageFixture();
      const altered = JSON.parse(input.artifact.definitions[field]);
      const name = field === "appHeld" ? "app" : "postgres";
      altered.services[name].env.push("UNREVIEWED=changed");
      input.artifact.definitions[field] = JSON.stringify(altered);
      // Even a correctly recomputed submitted hash cannot authorize an arbitrary native delta.
      const digest = createHash("sha256")
        .update(input.artifact.definitions[field])
        .digest("hex");
      if (field === "sourceHeld")
        input.artifact.evidence.source.heldSdlHash = digest;
      else if (field === "targetNormal")
        input.artifact.evidence.target.normalSdlHash = digest;
      else input.artifact.evidence.app.heldSdlHash = digest;
      expect(() => qualifyPhysicalPostimages(input)).toThrow(
        "unreviewed_delta"
      );
    }
  });
});

function shaBytes(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function rehashPrivatePostimages(input: ReturnType<typeof postimageFixture>) {
  const { definitions: d, evidence: e } = input.artifact;
  e.source.heldSdlHash = shaBytes(d.sourceHeld);
  e.target.preimageSdlHash = shaBytes(d.targetCold);
  e.target.normalSdlHash = shaBytes(d.targetNormal);
  e.app.preimageSdlHash = shaBytes(d.appOriginal);
  e.app.heldSdlHash = shaBytes(d.appHeld);
  const script = (value: string) => {
    const service = JSON.parse(value).services.postgres;
    return JSON.stringify([service.command ?? [], service.args ?? []]);
  };
  e.copy.originalStartupSha256 = shaBytes(script(d.sourceOriginal));
  e.copy.targetStartupSha256 = shaBytes(script(d.targetNormal));
}
describe("independent preimage anchors", () => {
  it("compares actual recorded-domain bytes without equating canonical and Console raw hashes", () => {
    const input = postimageFixture();
    expect(shaBytes(input.artifact.definitions.sourceOriginal)).not.toBe(
      input.ledgerHashes.source
    );
    expect(shaBytes(input.artifact.definitions.targetCold)).not.toBe(
      input.ledgerHashes.target
    );
    expect(shaBytes(input.artifact.definitions.appOriginal)).not.toBe(
      input.ledgerHashes.app
    );
    expect(() => qualifyPhysicalPostimages(input)).not.toThrow();
  });
  it("rejects the coherent source-original plus target-startup fsync=off substitution", () => {
    const input = postimageFixture();
    for (const field of ["sourceOriginal", "targetNormal"] as const) {
      const value = JSON.parse(input.artifact.definitions[field]);
      value.services.postgres.command = ["postgres"];
      value.services.postgres.args = ["-c", "fsync=off"];
      input.artifact.definitions[field] = JSON.stringify(value);
    }
    rehashPrivatePostimages(input);
    // Source hold is unchanged and all artifact-local startup/native hashes match.
    // The separately recorded source bytes still forbid changing the original.
    expect(() => qualifyPhysicalPostimages(input)).toThrow("unreviewed_delta");
    input.artifact.ledgerPreimages.sourceOriginal =
      input.artifact.definitions.sourceOriginal;
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_ledger_anchor"
    );
  });
  it("rejects paired app-original and held non-database env changes with coherently rehashed receipts", () => {
    const input = postimageFixture();
    for (const field of ["appOriginal", "appHeld"] as const) {
      const value = JSON.parse(input.artifact.definitions[field]);
      value.services.app.env = value.services.app.env.map((v: string) =>
        v === "KEEP=original" ? "KEEP=changed" : v
      );
      input.artifact.definitions[field] = JSON.stringify(value);
    }
    rehashPrivatePostimages(input);
    expect(() => qualifyPhysicalPostimages(input)).toThrow("unreviewed_delta");
    input.artifact.ledgerPreimages.appOriginal =
      input.artifact.definitions.appOriginal;
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_ledger_anchor"
    );
  });
  it("rejects malformed env entries even in independently anchored originals", () => {
    const input = postimageFixture();
    for (const field of ["appOriginal", "appHeld"] as const) {
      const value = JSON.parse(input.artifact.definitions[field]);
      value.services.app.env.push("MALFORMED_ENV");
      input.artifact.definitions[field] = JSON.stringify(value);
    }
    input.artifact.ledgerPreimages.appOriginal =
      input.artifact.definitions.appOriginal;
    input.ledgerHashes.app = shaBytes(
      input.artifact.ledgerPreimages.appOriginal
    );
    input.artifact.evidence.app.originalAppliedSdlHash = input.ledgerHashes.app;
    rehashPrivatePostimages(input);
    expect(() => qualifyPhysicalPostimages(input)).toThrow();
  });
  it("rejects a paired cold-recipe and normal capacity change even with new self-consistent preimage bytes", () => {
    const input = postimageFixture();
    for (const field of ["targetCold", "targetNormal"] as const) {
      const value = JSON.parse(input.artifact.definitions[field]);
      value.profiles.resources.storage = 50;
      input.artifact.definitions[field] = JSON.stringify(value);
    }
    rehashPrivatePostimages(input);
    expect(() => qualifyPhysicalPostimages(input)).toThrow("unreviewed_delta");
    input.artifact.ledgerPreimages.targetCold =
      input.artifact.definitions.targetCold;
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_ledger_anchor"
    );
  });
});
