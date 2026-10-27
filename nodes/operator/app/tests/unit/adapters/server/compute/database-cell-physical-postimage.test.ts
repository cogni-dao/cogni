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
import { describe, expect, it, vi } from "vitest";
import { AkashComputeAdapter } from "@/adapters/server/compute/akash-compute.adapter";
import { canonicalEvidenceJson } from "@/adapters/server/compute/database-cell-applied-artifacts";
import {
  expectedPhysicalNativePostimages,
  PhysicalRecoveryArtifactSchema,
  qualifyCurrentPhysicalApp,
  qualifyLivePhysicalPostimage,
  qualifyPhysicalPostimages,
} from "@/adapters/server/compute/database-cell-physical-postimage";
import {
  AppliedDatabaseCellReceiptSchema,
  physicalSourceBindingSha256,
} from "@/shared/secrets/database-cell-placement.data";
import type { DatabaseCellAppliedCustody } from "@/types/database-cell";

function basePostimageFixture() {
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
      sourceRawMetadataSha256: sha("2"),
      targetRawMetadataSha256: "d".repeat(64),
      normalizedMetadataDomain:
        "path-kind-mode-uid-gid-size-mtime-link-hardlink-v1",
      sourceNormalizedMetadataSha256: sha("2"),
      targetNormalizedMetadataSha256: sha("2"),
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
      kind: "incident-owner",
      approvalArtifactSha256: sha("f"),
      providerOperationsSettled: true,
      custodyVersionsSha256: sha("3"),
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
      ledgerPreimages: { targetCold: ledgerPreimages.targetCold },
    }),
    ledgerHashes,
    custody,
    primaryServiceName: "postgres",
    appServiceName: "app",
  };
}
function shaBytes(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function rehashPrivatePostimages(
  input: ReturnType<typeof basePostimageFixture>
) {
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
function nativeFixture(definition: ReturnType<typeof JSON.parse>) {
  const service = structuredClone(definition.services.postgres);
  service.params.storage = Object.entries(service.params.storage).map(
    ([name, mount]) => ({ name, ...(mount as object) })
  );
  return [
    {
      name: "dcloud",
      services: [
        {
          name: "postgres",
          ...service,
          resources: structuredClone(definition.profiles.resources),
          count: 1,
          credentials: null,
        },
      ],
    },
  ];
}
function legacyPostimageFixture() {
  const input = basePostimageFixture(),
    d = input.artifact.definitions,
    e = input.artifact.evidence;
  const original = JSON.parse(d.sourceOriginal);
  original.services.postgres.command = ["/bin/sh", "-ec"];
  original.services.postgres.args = [
    "exec postgres -c fsync=on -c synchronous_commit=on -c full_page_writes=on",
  ];
  d.sourceOriginal = JSON.stringify(original);
  const held = structuredClone(original);
  held.services.postgres.command = ["sleep"];
  held.services.postgres.args = ["infinity"];
  held.services.postgres.params.storage.database.readOnly = true;
  d.sourceHeld = JSON.stringify(held);
  const guard = "# independently reviewed existing-cluster guard\n";
  const normal = JSON.parse(d.targetNormal);
  normal.services.postgres = structuredClone(original.services.postgres);
  normal.services.postgres.args = [guard + original.services.postgres.args[0]];
  d.targetNormal = JSON.stringify(normal);
  d.appHeld = d.appOriginal;
  input.ledgerHashes.source = "d".repeat(64);
  e.source.originalAppliedSdlHash = input.ledgerHashes.source;
  const at = e.observedAt,
    packet = "a".repeat(64),
    authority = {
      kind: "conversation-user",
      label: "CEO",
      humanAppUserId: null,
      source: "direct-user-instruction",
      decisionRef: "fixture:approved",
      capturedAt: at,
      delegationDigest: "f".repeat(64),
    };
  const binding = AppliedDatabaseCellReceiptSchema.parse({
    allocationEnvironment: "production",
    targetBuildSha: input.custody.targetBuildSha,
    registration: {
      kind: "audited-manual",
      executionActor: { kind: "agent", id: input.custody.nodeId },
      approvalAuthority: authority,
      readmissionReceiptId: "genuine-source-admission",
      manualCutoverPacketSha256: packet,
      sourceSystemIdentifier: "777777777",
      scheduledBackupReceiptSha256: packet,
      independentRecoveryReceiptSha256: packet,
      appAllocationReceiptId: "00000000-0000-4000-8000-000000000003",
      appSdlHash: input.ledgerHashes.app,
      appDsnSha256: shaBytes("old-app"),
      serviceDsnSha256: shaBytes("old-service"),
      migrationDsnSha256: shaBytes("old-app"),
      migrationConsumer: "app-database-url",
      tlsTrustKind: "system",
      registeredAt: at,
    },
    binding: {
      version: 1,
      phase: "applied",
      receiptId: e.source.receiptId,
      cogniKey: e.source.cogniKey,
      nodeId: input.custody.nodeId,
      nodeSlug: "fixture",
      environment: "production",
      provider: "akash",
      dseq: e.source.dseq,
      providerAccount: e.source.providerAccount,
      endpoint: {
        host: "source.fixture.invalid",
        port: 25432,
        tlsMode: "verify-full",
        tlsCertificateSha256: packet,
      },
      databaseName: "cogni_fixture",
      appRole: "app_fixture",
      serviceRole: "service_fixture",
      systemIdentifier: e.source.systemIdentifier,
      failureDomainId: `akash:${e.source.providerAccount}:${e.source.dseq}`,
      manualProvenance: input.custody.manualProvenance,
      budgetProfile: "shared-default-v1",
      appliedSdlHash: input.ledgerHashes.source,
      readyAt: at,
      cutover: {
        packetSha256: packet,
        actorId: "human:fixture",
        approvedAt: at,
      },
    },
  });
  const capture = {
    sourceCapturedAt: e.copy.startedAt,
    originalStoredSdl: JSON.stringify({
      ...original,
      services: {
        postgres: {
          ...original.services.postgres,
          env: original.services.postgres.env.map(
            (v: string) =>
              `${v.slice(0, v.indexOf("=") + 1)}ac-secret://source-alias`
          ),
        },
      },
    }),
    originalAppStoredSdl: d.appOriginal,
    originalProviderManifest: nativeFixture(original),
    targetColdStoredSdl: d.targetCold,
    targetColdProviderManifest: nativeFixture(JSON.parse(d.targetCold)),
    originalAppProviderManifest: [
      {
        services: [{ name: "app", ...JSON.parse(d.appOriginal).services.app }],
      },
    ],
    sourceBinding: binding,
    historicalCanonicalBytesRecovered: false as const,
  };
  input.artifact.nativeCapture = capture;
  input.artifact.startupGuard = guard;
  input.custody = {
    ...input.custody,
    physicalRecoverySource: {
      kind: "legacy-native-capture",
      incidentRef: "https://fixture.invalid/incidents/recovery",
      sourceReceiptId: e.source.receiptId,
      captureSha256: shaBytes(canonicalEvidenceJson(capture)),
      sourceBindingSha256: physicalSourceBindingSha256(binding),
      approvalArtifactSha256: authority.delegationDigest,
      startupGuardSha256: shaBytes(guard),
    },
  };
  rehashPrivatePostimages(input);
  e.copy.originalStartupSha256 = shaBytes(original.services.postgres.args[0]);
  e.copy.targetStartupSha256 = shaBytes(normal.services.postgres.args[0]);
  return input;
}

describe("authenticated legacy native custody", () => {
  it("accepts preserved unknown historical bytes and separately approved guard without fake SDK equality", () => {
    const input = legacyPostimageFixture();
    expect(shaBytes(input.artifact.definitions.sourceOriginal)).not.toBe(
      input.ledgerHashes.source
    );
    expect(() => qualifyPhysicalPostimages(input)).not.toThrow();
  });
  it("rejects coherently changed originals and target startup against the independently pinned capture", () => {
    const input = legacyPostimageFixture();
    const capture = input.artifact.nativeCapture;
    if (!capture) throw new Error("capture missing");
    for (const name of ["sourceOriginal", "targetNormal"] as const) {
      const changed = JSON.parse(input.artifact.definitions[name]);
      changed.services.postgres.args = ["exec postgres -c fsync=off"];
      input.artifact.definitions[name] = JSON.stringify(changed);
    }
    capture.originalProviderManifest[0].services[0].args = [
      "exec postgres -c fsync=off",
    ];
    rehashPrivatePostimages(input);
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_custody"
    );
  });
  it("rejects replacement guard or a secretly retargeted business consumer", () => {
    const input = legacyPostimageFixture();
    input.artifact.startupGuard = "# bypass existing cluster checks\n";
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_custody"
    );
    const moved = legacyPostimageFixture();
    const capture = moved.artifact.nativeCapture;
    if (!capture) throw new Error("capture missing");
    capture.originalAppProviderManifest[0].services[0].env = [
      "DATABASE_URL=new-app",
      "DATABASE_SERVICE_URL=old-service",
    ];
    expect(() => qualifyPhysicalPostimages(moved)).toThrow(
      "independent_custody"
    );
  });
});

describe("fixed legacy postimage boundaries", () => {
  it("refuses coherently rehashed source hold, target env and app changes", () => {
    for (const field of ["sourceHeld", "targetNormal", "appHeld"] as const) {
      const input = legacyPostimageFixture();
      const value = JSON.parse(input.artifact.definitions[field]);
      const name = field === "appHeld" ? "app" : "postgres";
      value.services[name].env.push("UNREVIEWED=changed");
      input.artifact.definitions[field] = JSON.stringify(value);
      rehashPrivatePostimages(input);
      expect(() => qualifyPhysicalPostimages(input)).toThrow();
    }
  });
  it("keeps the cold recipe independently ledger anchored", () => {
    const input = legacyPostimageFixture();
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
  it("rejects missing independent capture or altered historical source binding", () => {
    const input = legacyPostimageFixture();
    delete input.artifact.nativeCapture;
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_custody"
    );
    const changed = legacyPostimageFixture();
    const capture = changed.artifact.nativeCapture;
    if (!capture) throw new Error("capture absent");
    capture.sourceBinding.registration.readmissionReceiptId =
      "invented-source-admission";
    expect(() => qualifyPhysicalPostimages(changed)).toThrow(
      "independent_custody"
    );
  });
});

describe("complete live physical postimage binding", () => {
  function liveFixture() {
    const input = legacyPostimageFixture();
    const approved = input.artifact.definitions.targetNormal;
    const stored = JSON.parse(approved);
    const service = stored.services.postgres;
    const expected = expectedPhysicalNativePostimages(
      input.artifact,
      "postgres"
    ).targetNormal;
    const native = JSON.parse(JSON.stringify(expected));
    service.env = service.env.map(
      (entry: string) =>
        `${entry.slice(0, entry.indexOf("=") + 1)}ac-secret://new-target-alias`
    );
    return { stored, native, approved, expected };
  }
  it("privately resolves current provider aliases and compares the entire approved configuration", () => {
    const f = liveFixture();
    expect(() =>
      qualifyLivePhysicalPostimage(
        JSON.stringify(f.stored),
        f.native,
        f.approved,
        "postgres",
        f.expected
      )
    ).not.toThrow();
    expect(() =>
      qualifyLivePhysicalPostimage(
        JSON.stringify(f.stored),
        undefined,
        f.approved,
        "postgres",
        f.expected
      )
    ).toThrow();
  });
  it("refuses coherently different live startup/mount/resources despite hashes matching those live bytes", () => {
    for (const mutate of [
      (f: ReturnType<typeof liveFixture>) => {
        f.stored.services.postgres.args = ["postgres -c fsync=off"];
        f.native[0].services[0].args = ["postgres -c fsync=off"];
      },
      (f: ReturnType<typeof liveFixture>) => {
        f.stored.services.postgres.params.storage.database.mount = "/different";
        f.native[0].services[0].params.storage[0].mount = "/different";
      },
      (f: ReturnType<typeof liveFixture>) => {
        f.stored.profiles.resources.memory = 64;
      },
    ]) {
      const f = liveFixture();
      mutate(f);
      const currentBytes = JSON.stringify(f.stored),
        currentHash = shaBytes(currentBytes);
      expect(currentHash).not.toBe(shaBytes(f.approved));
      expect(() =>
        qualifyLivePhysicalPostimage(
          currentBytes,
          f.native,
          f.approved,
          "postgres",
          f.expected
        )
      ).toThrow();
    }
  });
  it("does not turn arbitrary opaque or literal env into an approved secret", () => {
    const f = liveFixture();
    f.stored.services.postgres.env = ["PGDATA=opaque"];
    expect(() =>
      qualifyLivePhysicalPostimage(
        JSON.stringify(f.stored),
        f.native,
        f.approved,
        "postgres",
        f.expected
      )
    ).toThrow();
  });
});

describe("existing managed reader private resolved-manifest observation", () => {
  function readerFixture(wrongScope = false) {
    const f = legacyPostimageFixture();
    const owner = "akash1synthetic-owner",
      provider = f.artifact.evidence.target.providerAccount;
    const version = Buffer.alloc(32, 1).toString("base64");
    const requests: { url: string; method: string; body: unknown }[] = [];
    const native = [
      {
        services: [
          {
            name: "postgres",
            ...JSON.parse(f.artifact.definitions.targetNormal).services
              .postgres,
          },
        ],
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method: init?.method ?? "GET", body });
      let result: unknown;
      if (url.endsWith("/v1/deployments/10002"))
        result = {
          data: {
            deployment: {
              id: { dseq: "10002", owner },
              state: "active",
              hash: version,
            },
            consoleSettings: {
              sdl: f.artifact.definitions.targetNormal,
              manifestVersion: version,
            },
            leases: [
              {
                state: "active",
                id: { dseq: "10002", gseq: 1, oseq: 1, provider },
                status: {
                  services: {
                    postgres: {
                      observed_generation: 1,
                      replicas: 1,
                      updated_replicas: 1,
                      ready_replicas: 1,
                      available_replicas: 1,
                      total: 1,
                      available: 1,
                    },
                  },
                },
              },
            ],
          },
        };
      else if (url.endsWith(`/v1/providers/${provider}`))
        result = { data: { hostUri: "https://provider.fixture.invalid:8443" } };
      else if (url.endsWith("/v1/create-jwt-token")) {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: owner,
          iat: now,
          exp: now + 60,
          leases: wrongScope ? { access: "full" } : body.data.leases,
        };
        result = {
          data: {
            token: `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
          },
        };
      } else if (url === "https://console.akash.network/provider-proxy-mainnet")
        result = native;
      else throw new Error("unexpected synthetic request");
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const adapter = new AkashComputeAdapter({
      apiKey: "synthetic-console-key",
      expectedCostConsumerAccountId: owner,
      timeoutMs: 1000,
      outcomeStore: { record: async () => {}, stats: async () => new Map() },
      fetchImpl,
    });
    return { adapter, requests, native };
  }
  it("uses exact owned lease get-manifest scope and fixed GET proxy without exposing the account key", async () => {
    const f = readerFixture();
    const observed = await f.adapter.readManagedDefinition({
      leaseId: "10002",
      resolveProviderManifest: true,
    });
    expect(observed.resolvedProviderManifest).toEqual(f.native);
    const mint = f.requests.find((r) => r.url.endsWith("create-jwt-token"));
    expect(mint?.body).toMatchObject({
      data: {
        ttl: 60,
        leases: {
          access: "granular",
          permissions: [
            {
              access: "granular",
              deployments: [
                {
                  scope: ["get-manifest"],
                  dseq: 10002,
                  gseq: 1,
                  oseq: 1,
                  services: ["postgres"],
                },
              ],
            },
          ],
        },
      },
    });
    const proxy = f.requests.at(-1);
    expect(proxy?.body).toMatchObject({
      method: "GET",
      url: "https://provider.fixture.invalid:8443/lease/10002/1/1/manifest",
      auth: { type: "jwt" },
    });
    expect(JSON.stringify(proxy)).not.toContain("synthetic-console-key");
    expect(f.requests.map((r) => r.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "POST",
    ]);
  });
  it("refuses broader JWT scope before touching the provider and leaves ordinary reads unchanged", async () => {
    const invalid = readerFixture(true);
    await expect(
      invalid.adapter.readManagedDefinition({
        leaseId: "10002",
        resolveProviderManifest: true,
      })
    ).rejects.toThrow("physical manifest observation failed");
    expect(invalid.requests.some((r) => r.url.includes("provider-proxy"))).toBe(
      false
    );
    const ordinary = readerFixture();
    expect(
      (await ordinary.adapter.readManagedDefinition({ leaseId: "10002" }))
        .resolvedProviderManifest
    ).toBeUndefined();
    expect(ordinary.requests).toHaveLength(1);
  });
});

describe("complete independent native capture chain", () => {
  it("rejects coherent sourceOriginal/sourceHeld profile, deployment and expose changes with unchanged capture", () => {
    for (const change of [
      (value: ReturnType<typeof JSON.parse>) => {
        value.profiles.resources.memory = 128;
      },
      (value: ReturnType<typeof JSON.parse>) => {
        value.deployment = {
          postgres: { dcloud: { profile: "different", count: 2 } },
        };
      },
      (value: ReturnType<typeof JSON.parse>) => {
        value.services.postgres.expose[0].as = 9999;
      },
    ]) {
      const f = legacyPostimageFixture();
      for (const name of ["sourceOriginal", "sourceHeld"] as const) {
        const value = JSON.parse(f.artifact.definitions[name]);
        change(value);
        f.artifact.definitions[name] = JSON.stringify(value);
      }
      rehashPrivatePostimages(f);
      expect(() => qualifyPhysicalPostimages(f)).toThrow("unreviewed_delta");
    }
  });
  it("rejects live native-only resources, expose, count and credentials drift with approved stored SDL unchanged", () => {
    for (const change of [
      (service: ReturnType<typeof JSON.parse>) => {
        service.resources.memory = 999;
      },
      (service: ReturnType<typeof JSON.parse>) => {
        service.expose[0].port = 9999;
      },
      (service: ReturnType<typeof JSON.parse>) => {
        service.count = 2;
      },
      (service: ReturnType<typeof JSON.parse>) => {
        service.credentials = { host: "different" };
      },
    ]) {
      const f = legacyPostimageFixture(),
        expected = expectedPhysicalNativePostimages(
          f.artifact,
          "postgres"
        ).targetNormal;
      const current = structuredClone(expected);
      change(current[0]?.services[0]);
      expect(() =>
        qualifyLivePhysicalPostimage(
          f.artifact.definitions.targetNormal,
          current,
          f.artifact.definitions.targetNormal,
          "postgres",
          expected
        )
      ).toThrow("unreviewed_delta");
    }
  });
  it("checks current app resolved consumers even when stored aliases and target session count stay unchanged", () => {
    const f = legacyPostimageFixture(),
      capture = f.artifact.nativeCapture;
    if (!capture) throw new Error("capture missing");
    capture.originalAppProviderManifest[0].services.push({
      name: "nonconsumer",
      image: "synthetic-sidecar",
    });
    const app = JSON.parse(capture.originalAppStoredSdl);
    app.services.app.env = [
      "DATABASE_URL=ac-secret://stable-app-alias",
      "DATABASE_SERVICE_URL=ac-secret://stable-service-alias",
      "KEEP=original",
    ];
    capture.originalAppStoredSdl = JSON.stringify(app);
    f.artifact.definitions.appOriginal = capture.originalAppStoredSdl;
    f.artifact.definitions.appHeld = capture.originalAppStoredSdl;
    if (!f.custody.physicalRecoverySource) throw new Error("anchor missing");
    f.custody = {
      ...f.custody,
      physicalRecoverySource: {
        ...f.custody.physicalRecoverySource,
        captureSha256: shaBytes(canonicalEvidenceJson(capture)),
      },
    };
    f.artifact.evidence.app.preimageSdlHash = shaBytes(
      capture.originalAppStoredSdl
    );
    f.artifact.evidence.app.heldSdlHash = shaBytes(
      capture.originalAppStoredSdl
    );
    expect(() => qualifyPhysicalPostimages(f)).not.toThrow();
    expect(() =>
      qualifyCurrentPhysicalApp(f.artifact, capture.originalAppProviderManifest)
    ).not.toThrow();
    const current = structuredClone(capture.originalAppProviderManifest);
    current[0].services[0].env = [
      "DATABASE_URL=new-target-app",
      "DATABASE_SERVICE_URL=old-service",
      "KEEP=original",
    ];
    expect(() => qualifyCurrentPhysicalApp(f.artifact, current)).toThrow(
      "unreviewed_delta"
    );
  });
});
