// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/akash-tx-declared-images`
 * Purpose: Exercise the private HTTP→actor→owned Console reader image-evidence seam.
 * Scope: Real schemas, dispatch, actor and adapter; injected provider transport and ledger ports.
 * Invariants: No live IO or paid mutation; serving truth is independent of image agreement.
 * Side-effects: In-memory fixtures only.
 * Links: subtask.5032, compute.akash-tx.v1.contract.ts
 * @internal
 */
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { AkashComputeAdapter } from "@/adapters/server/compute/akash-compute.adapter";
import {
  AkashTxObserveInputSchema,
  AkashTxObserveOutputSchema,
} from "@/contracts/compute.akash-tx.v1.contract";
import { AkashTxActuator } from "@/features/compute/akash-tx/akash-tx-actuator";
import { createAkashTxDispatcher } from "@/features/compute/akash-tx/akash-tx-http";
import type {
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
} from "@/ports";

// The ports barrel also exports unrelated graph runtimes. Keep their optional SDKs out of
// this contract test while using the real actuator error class and all production seams.
vi.mock("@/ports", () => import("@/ports/akash-tx.port"));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const source = "a".repeat(40);
const image = `ghcr.io/example/app@sha256:${"1".repeat(64)}`;
const workerImage = `ghcr.io/example/worker@sha256:${"2".repeat(64)}`;
const secret = "private-desired-and-provider-value";
const provider = "akash1provider";
const version = Buffer.alloc(32, 1).toString("base64");
const observedAt = "2026-11-01T00:30:00.000Z";
const identity = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  compositeUid: "xr-owned",
  compositeGeneration: 9,
};
const service = (name: string, serviceImage: string) => ({
  name,
  image: serviceImage,
  cpuUnits: 0.5,
  memoryMi: 512,
  storageMi: 1024,
  env: { COGNI_REPO_SHA: source, PRIVATE_VALUE: secret },
});
const desired = {
  identity,
  spec: {
    name: "echo",
    services: [service("app", image), service("worker", workerImage)],
  },
};
const request = {
  cogniKey: "xcw:candidate-a:echo:3",
  externalName: "7001",
  environment: "candidate-a",
  expectedSourceSha: source,
  desired,
};
const counters = {
  observed_generation: 1,
  replicas: 1,
  updated_replicas: 1,
  ready_replicas: 1,
  available_replicas: 1,
  total: 1,
  available: 1,
};
function definition() {
  const lease = {
    state: "active",
    id: { dseq: "7001", provider },
    status: {
      services: { app: { ...counters }, worker: { ...counters } } as Record<
        string,
        Partial<typeof counters>
      >,
      uris: ["owned.example.org"],
    },
  };
  return {
    deployment: {
      id: { dseq: "7001", owner: "akash1consumer" },
      state: "active",
      hash: version,
    },
    consoleSettings: {
      manifestVersion: version,
      sdl: stringify({
        services: {
          app: { image, env: [`PRIVATE_VALUE=${secret}`] },
          worker: { image: workerImage },
        },
      }),
    },
    leases: [lease] as [typeof lease],
  };
}
function fixture() {
  const record: AkashTxAllocationRecord = {
    receiptId: "receipt-owned",
    cogniKey: request.cogniKey,
    identity: { ...identity, compositeGeneration: 1 },
    workload: "echo",
    environment: request.environment,
    state: "allocated",
    externalName: "7001",
    providerAccount: provider,
  };
  const denyMutation = () =>
    vi.fn(async () => {
      throw new Error("unexpected ledger mutation");
    });
  const mutations = {
    claim: denyMutation(),
    bindIdentity: denyMutation(),
    prepare: denyMutation(),
    recordAllocation: denyMutation(),
    recordAppliedSdlHash: denyMutation(),
    fail: denyMutation(),
    markReleased: denyMutation(),
  };
  const ledger: AkashTxAllocationLedgerPort = {
    ...mutations,
    read: vi.fn(async () => record),
    listStalePreparing: vi.fn(async () => []),
    listAllocated: vi.fn(async () => []),
    listReceipts: vi.fn(async () => []),
    listActive: vi.fn(async () => []),
  };
  const detail = definition();
  let readCount = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "GET")
      throw new Error("paid provider mutation forbidden");
    readCount++;
    // Independent resource status succeeds; only the comparison's later read can fail.
    return new Response(JSON.stringify({ data: detail }), { status: 200 });
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const adapter = new AkashComputeAdapter({
    apiKey: "fixture-not-a-credential",
    expectedCostConsumerAccountId: "akash1consumer",
    timeoutMs: 100,
    fetchImpl,
    outcomeStore: { record: vi.fn(), stats: async () => new Map() },
    now: () => new Date(observedAt),
  });
  const probe = vi.fn(async () => true);
  const migration = {
    ensure: vi.fn(async () => "succeeded" as const),
    readReceipt: vi.fn(async () => null),
  };
  const actuator = new AkashTxActuator({
    console: adapter,
    clock: { now: () => observedAt },
    ledger,
    probe,
    migration,
    log,
    providerConsumerAccountId: "akash1consumer",
    costEvidence: {
      observeCost: vi.fn(async () => ({
        computeProvider: "akash",
        resourceId: "7001",
        providerConsumerAccountId: "akash1consumer",
        providerSupplierAccountId: provider,
        rate: { amount: "1", denom: "uact", unit: "block" },
        escrow: { state: "open", funds: [], transferred: [] },
        observedAt: new Date(observedAt),
      })),
    },
    costStore: {
      bind: vi.fn(),
      observe: vi.fn(),
      close: vi.fn(),
      reportByNode: async () => [],
      reportByNodeIds: async () => [],
    },
  });
  const dispatch = createAkashTxDispatcher({
    actuator,
    token: "fixture-token",
    log,
  });
  const send = (
    body: unknown = request,
    authorization = "Bearer fixture-token"
  ) =>
    dispatch({
      method: "POST",
      path: "/v1/akash/observe",
      authorization,
      body: JSON.stringify(body),
    });
  return {
    record,
    ledger,
    mutations,
    adapter,
    actuator,
    log,
    migration,
    probe,
    fetchImpl,
    send,
    getDetail: () => detail,
    reads: () => readCount,
  };
}

function evidence(body: unknown) {
  const parsed = AkashTxObserveOutputSchema.parse(body);
  expect(parsed.found).toBe(true);
  expect(parsed.serving).toBe(true);
  expect(parsed.resource).toMatchObject({
    externalName: "7001",
    state: "active",
    endpoints: ["owned.example.org"],
  });
  return parsed.declaredServiceImages;
}
function assertNoMutation(current: ReturnType<typeof fixture>) {
  for (const mutation of Object.values(current.mutations))
    expect(mutation).not.toHaveBeenCalled();
  expect(
    current.fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")
  ).toBe(true);
}

describe("private declared service-image evidence", () => {
  it("matches complete named immutable images through HTTP at the requested generation without rebinding allocation", async () => {
    const current = fixture();
    const before = structuredClone(current.record);
    const result = await current.send();
    expect(result.status).toBe(200);
    expect(evidence(result.body)).toEqual({
      result: "matched",
      reason: "service_images_match",
      observedAt,
      subject: {
        ...identity,
        environment: request.environment,
        cogniKey: request.cogniKey,
        externalName: "7001",
        expectedSourceSha: source,
      },
    });
    expect(current.record).toEqual(before);
    expect(current.probe).toHaveBeenCalledOnce();
    assertNoMutation(current);
    expect(
      JSON.stringify([
        result,
        current.log.info.mock.calls,
        current.log.warn.mock.calls,
        current.log.error.mock.calls,
      ])
    ).not.toContain(secret);
  });

  it.each([
    "different",
    "missing",
    "extra",
    "swapped",
  ])("refuses %s service-image agreement while the requested public source still serves", async (change) => {
    const current = fixture();
    const services: Record<string, { image: string }> = {
      app: { image },
      worker: { image: workerImage },
    };
    if (change === "different")
      services.app = { image: `ghcr.io/example/app@sha256:${"3".repeat(64)}` };
    if (change === "missing") delete services.worker;
    if (change === "extra") services.extra = { image };
    if (change === "swapped") {
      services.app = { image: workerImage };
      services.worker = { image };
    }
    const detail = current.getDetail();
    detail.consoleSettings.sdl = stringify({ services });
    // Completeness of each provider snapshot is independent of desired-map equality.
    detail.leases[0].status.services = Object.fromEntries(
      Object.keys(services).map((name) => [name, { ...counters }])
    );
    const result = await current.send();
    expect(result.status).toBe(200);
    expect(evidence(result.body)).toMatchObject({
      result: "mismatched",
      reason: "service_images_differ",
    });
    assertNoMutation(current);
  });

  it.each([
    "mutable",
    "duplicate",
    "opaque",
    "incomplete",
    "version",
    "counter",
    "owner",
    "provider",
    "multiple-leases",
    "oversized",
  ])("reports fixed unknown for %s definitions without changing independently observed resource/serving truth", async (change) => {
    const current = fixture();
    const detail = current.getDetail();
    if (change === "mutable")
      detail.consoleSettings.sdl = `services:\n  app: {image: example/app:latest}\n  worker: {image: '${workerImage}'}\n`;
    if (change === "duplicate")
      detail.consoleSettings.sdl = `services:\n  app: {image: '${image}'}\n  app: {image: '${image}'}\n`;
    if (change === "opaque")
      detail.consoleSettings.sdl = `services:\n  app: {image: opaque}\n`;
    if (change === "incomplete")
      detail.consoleSettings.sdl = `services:\n  app: {env: [PRIVATE_VALUE=${secret}]}\n`;
    if (change === "version")
      detail.consoleSettings.manifestVersion = Buffer.alloc(32, 2).toString(
        "base64"
      );
    if (change === "counter") {
      const app = detail.leases[0].status.services.app;
      if (app) delete app.total;
    }
    if (change === "owner") detail.deployment.id.owner = "foreign";
    if (change === "provider")
      detail.leases[0].id.provider = "foreign-provider";
    if (change === "multiple-leases")
      detail.leases.push(structuredClone(detail.leases[0]));
    if (change === "oversized")
      detail.consoleSettings.sdl = secret.repeat(20000);
    const result = await current.send();
    expect(result.status).toBe(200);
    expect(evidence(result.body)).toMatchObject({ result: "unknown" });
    expect(JSON.stringify(result)).not.toContain(secret);
    assertNoMutation(current);
  });

  it("keeps read failures unknown and does not reuse a previous match", async () => {
    const current = fixture();
    expect(evidence((await current.send()).body)?.result).toBe("matched");
    let calls = 0;
    current.fetchImpl.mockImplementation(async () => {
      if (++calls === 1)
        return new Response(JSON.stringify({ data: current.getDetail() }));
      throw new Error(secret);
    });
    const failed = await current.send();
    expect(failed.status).toBe(200);
    expect(evidence(failed.body)).toMatchObject({
      result: "unknown",
      reason: "managed_definition_unavailable",
    });
    expect(
      JSON.stringify([
        failed,
        current.log.warn.mock.calls,
        current.log.error.mock.calls,
      ])
    ).not.toContain(secret);
    assertNoMutation(current);
  });

  it("rechecks same-source changed desired images and restart instead of using receipt/hash/cache", async () => {
    const current = fixture();
    expect(evidence((await current.send()).body)?.result).toBe("matched");
    const changed = structuredClone(request);
    changed.desired.spec.services = [
      service("app", workerImage),
      service("worker", workerImage),
    ];
    expect(evidence((await current.send(changed)).body)?.result).toBe(
      "mismatched"
    );
    const restarted = fixture();
    expect(evidence((await restarted.send(changed)).body)?.result).toBe(
      "mismatched"
    );
    assertNoMutation(current);
    assertNoMutation(restarted);
  });

  it.each([
    "node",
    "uid",
    "key",
    "handle",
    "environment",
  ])("refuses foreign %s ownership before migration, native reads, probes or metadata disclosure", async (change) => {
    const current = fixture();
    const body = {
      ...structuredClone(request),
      workload: "echo",
      migration: {
        profile: "cogni-node-app-v1",
        bundleDigest: `sha256:${"b".repeat(64)}`,
        image,
        doltgres: false,
      },
    };
    if (change === "node")
      body.desired.identity.nodeId = "22222222-2222-4222-8222-222222222222";
    if (change === "uid") body.desired.identity.compositeUid = "foreign-xr";
    if (change === "key") body.cogniKey = "foreign-key";
    if (change === "handle") body.externalName = "7002";
    if (change === "environment") body.environment = "preview";
    const result = await current.send(body);
    expect(result).toEqual({
      status: 422,
      body: {
        code: "identity_conflict",
        message: "desired observation does not own the allocated subject",
      },
    });
    expect(current.fetchImpl).not.toHaveBeenCalled();
    expect(current.probe).not.toHaveBeenCalled();
    expect(current.migration.ensure).not.toHaveBeenCalled();
    assertNoMutation(current);
  });

  it("validates desired source/workload bindings, strict nested input, and required environment before any IO", async () => {
    for (const invalid of [
      { ...request, expectedSourceSha: undefined },
      { ...request, environment: undefined },
      { ...request, workload: "other" },
      { ...request, expectedSourceSha: "b".repeat(40) },
      { ...request, desired: { ...desired, extra: true } },
      {
        ...request,
        desired: { ...desired, identity: { ...identity, extra: true } },
      },
    ]) {
      const current = fixture();
      expect((await current.send(invalid)).status).toBe(400);
      expect(current.fetchImpl).not.toHaveBeenCalled();
      expect(current.ledger.read).not.toHaveBeenCalled();
    }
  });

  it("rejects duplicate/mutable desired images as unknown rather than allowing an apparent match", async () => {
    for (const services of [
      [service("app", image), service("app", image)],
      [service("app", "example/app:latest"), service("worker", workerImage)],
    ]) {
      const current = fixture();
      const result = await current.send({
        ...request,
        desired: { ...desired, spec: { ...desired.spec, services } },
      });
      expect(result.status).toBe(200);
      expect(evidence(result.body)).toMatchObject({
        result: "unknown",
        reason: "desired_images_invalid",
      });
      assertNoMutation(current);
    }
  });

  it("accepts legacy bodies without comparison reads or added evidence", async () => {
    const current = fixture();
    const { desired: _desired, ...legacy } = request;
    expect(AkashTxObserveInputSchema.safeParse(legacy).success).toBe(true);
    const result = await current.send(legacy);
    expect(result.status).toBe(200);
    expect(evidence(result.body)).toBeUndefined();
    expect(current.reads()).toBe(1);
    assertNoMutation(current);
  });

  it("reports the incident mismatch even while the legacy response says serving=true", async () => {
    const current = fixture();
    current.getDetail().consoleSettings.sdl = stringify({
      services: { app: { image: workerImage }, worker: { image: workerImage } },
    });
    const { desired: _desired, ...legacy } = request;
    const before = await current.send(legacy);
    expect(evidence(before.body)).toBeUndefined();
    const after = await current.send();
    expect(evidence(after.body)?.result).toBe("mismatched");
    assertNoMutation(current);
  });

  it("binds a handle omitted by the caller from the same immutable receipt", async () => {
    const current = fixture();
    const { externalName: _handle, ...body } = request;
    expect(
      evidence((await current.send(body)).body)?.subject.externalName
    ).toBe("7001");
    expect(current.record.identity.compositeGeneration).toBe(1);
    assertNoMutation(current);
  });

  it("does not disclose or probe an unallocated subject before first CREATE", async () => {
    const current = fixture();
    vi.mocked(current.ledger.read).mockResolvedValue(null);
    expect((await current.send()).status).toBe(422);
    const { externalName: _handle, ...body } = request;
    expect(await current.send(body)).toEqual({
      status: 200,
      body: { found: false },
    });
    expect(current.fetchImpl).not.toHaveBeenCalled();
    expect(current.migration.ensure).not.toHaveBeenCalled();
    assertNoMutation(current);
  });

  it("keeps an absent or throwing comparison capability unknown with fixed redacted reasons", async () => {
    for (const missing of [false, true]) {
      const current = fixture();
      if (missing)
        Object.defineProperty(current.adapter, "compareDeclaredServiceImages", {
          value: undefined,
        });
      else
        vi.spyOn(
          current.adapter,
          "compareDeclaredServiceImages"
        ).mockRejectedValue(new Error(secret));
      const response = await current.send();
      expect(response.status).toBe(200);
      expect(evidence(response.body)).toMatchObject({
        result: "unknown",
        reason: "managed_definition_unavailable",
        observedAt,
      });
      expect(
        JSON.stringify([
          response,
          current.log.info.mock.calls,
          current.log.warn.mock.calls,
          current.log.error.mock.calls,
        ])
      ).not.toContain(secret);
      assertNoMutation(current);
    }
  });

  it("runs only the existing requested migration once on either wire shape", async () => {
    for (const newWire of [false, true]) {
      const current = fixture();
      const { desired: _desired, ...legacy } = request;
      const response = await current.send({
        ...(newWire ? request : legacy),
        workload: "echo",
        migration: {
          profile: "cogni-node-app-v1",
          bundleDigest: `sha256:${"b".repeat(64)}`,
          image,
          doltgres: false,
        },
      });
      expect(response.status).toBe(200);
      expect(AkashTxObserveOutputSchema.parse(response.body).migration).toEqual(
        { phase: "succeeded" }
      );
      expect(current.migration.ensure).toHaveBeenCalledOnce();
      expect(current.reads()).toBe(newWire ? 2 : 1);
      assertNoMutation(current);
    }
  });

  it("does not turn matched images into positive serving or revive a closed resource", async () => {
    const current = fixture();
    current.probe.mockResolvedValue(false);
    const response = await current.send();
    expect(AkashTxObserveOutputSchema.parse(response.body)).toMatchObject({
      found: true,
      serving: false,
      declaredServiceImages: { result: "matched" },
    });
    current.getDetail().deployment.state = "closed";
    const closed = AkashTxObserveOutputSchema.parse(
      (await current.send()).body
    );
    expect(closed).toMatchObject({
      found: true,
      serving: false,
      resource: { state: "closed" },
      declaredServiceImages: { result: "unknown" },
    });
    assertNoMutation(current);
  });

  it("authenticates before reading the desired subject", async () => {
    const current = fixture();
    expect((await current.send(request, "Bearer wrong")).status).toBe(401);
    expect(current.ledger.read).not.toHaveBeenCalled();
    expect(current.fetchImpl).not.toHaveBeenCalled();
  });
});
