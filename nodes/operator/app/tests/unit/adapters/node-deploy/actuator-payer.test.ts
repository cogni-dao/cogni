// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/actuator-payer`
 * Purpose: Prove ActuatorPayer speaks the actuator's REAL v1 wire (strictly validated by the contract's
 *   own zod schemas), carries only the bearer, and classifies every error code the way the sequencer's
 *   "never blindly re-create" rule needs (task.5400).
 * Side-effects: none (fetch is injected)
 */

import { describe, expect, it } from "vitest";
import { ActuatorPayer } from "@/adapters/server";
import {
  AkashTxCreateInputSchema,
  AkashTxDeleteInputSchema,
  AkashTxObserveInputSchema,
} from "@/contracts/compute.akash-tx.v1.contract";
import { toPayerSpec } from "@/features/node-deploy/spec";
import {
  canaryApp,
  canaryDb,
  NODE_ID,
  SHA_1,
} from "@/features/node-deploy/testing";
import { buildCogniKey, buildIdentity, PayerError } from "@/ports";

const RELEASE_ID = "6b564b98-7a28-4a7f-8b17-c65a1b3e2c96";

function recorder(
  respond: (
    url: string,
    init: RequestInit
  ) => { status: number; body: unknown } | Error
) {
  const calls: { url: string; init: RequestInit; json: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, json: JSON.parse(String(init.body)) });
    const r = respond(url, init);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const payerWith = (fetchImpl: typeof fetch) =>
  new ActuatorPayer({
    actuatorUrl: "http://akash-tx-actuator:8080/",
    token: "bearer-token-value",
    fetchImpl,
  });

const request = (env: Record<string, string> = { RELEASE_SHA: SHA_1 }) => ({
  cogniKey: buildCogniKey({
    namespace: "cogni-production",
    nodeId: NODE_ID,
    workload: "canary",
    releaseId: RELEASE_ID,
    attempt: 2,
  }),
  environment: "production",
  identity: buildIdentity({
    nodeId: NODE_ID,
    releaseId: RELEASE_ID,
    attempt: 2,
  }),
  spec: toPayerSpec(canaryApp(), env),
});

describe("ActuatorPayer wire", () => {
  it("create posts a body the actuator's strict v1 schema accepts, with only the bearer", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: {
        externalName: "1793410254406",
        state: "pending",
        endpoints: ["abc.ingress.provider.example"],
        providerAccount: "akash1provider",
        replayed: false,
        recovered: false,
      },
    }));
    const out = await payerWith(fetchImpl).create(request());
    expect(calls[0]?.url).toBe("http://akash-tx-actuator:8080/v1/akash/create");
    expect(
      (calls[0]?.init.headers as Record<string, string>).authorization
    ).toBe("Bearer bearer-token-value");
    const parsed = AkashTxCreateInputSchema.parse(calls[0]?.json);
    expect(parsed.identity).toEqual({
      nodeId: NODE_ID,
      compositeUid: `nd-${RELEASE_ID}`,
      compositeGeneration: 2,
    });
    expect(parsed.cogniKey).toBe(
      `nd:cogni-production:${NODE_ID}:canary:${RELEASE_ID}:2`
    );
    expect(parsed.spec.services[0]?.expose).toEqual([
      {
        port: 8080,
        as: 80,
        global: true,
        hosts: ["node-deploy-canary.cognidao.org"],
      },
    ]);
    expect(out).toEqual({
      externalName: "1793410254406",
      state: "pending",
      endpoints: ["abc.ingress.provider.example"],
      providerAccount: "akash1provider",
    });
  });

  it("sends excludeProviders (blue's provider) on the v1 wire; the strict schema accepts it; absent/empty/malformed are not sent", async () => {
    const blue = "akash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: {
        externalName: "1",
        state: "pending",
        endpoints: [],
        replayed: false,
        recovered: false,
      },
    }));
    const payer = payerWith(fetchImpl);
    await payer.create({ ...request(), excludeProviders: [blue] });
    expect(
      AkashTxCreateInputSchema.parse(calls[0]?.json).excludeProviders
    ).toEqual([blue]);
    await payer.create({ ...request(), cogniKey: "k2", excludeProviders: [] });
    await payer.create({ ...request(), cogniKey: "k3" });
    await payer.create({
      ...request(),
      cogniKey: "k4",
      excludeProviders: ["not-an-address"],
    });
    for (const c of calls.slice(1))
      expect("excludeProviders" in (c.json as Record<string, unknown>)).toBe(
        false
      );
  });

  it("sends allowProviders (task.5405) on the v1 wire; the strict schema accepts it; absent is byte-identical", async () => {
    const a = "akash16yr3wxt97ae045a06kr3ycde9srcgpg8syjxxm";
    const b = "akash1v0f04wr3tkh9uf43q9eqfd0whpfeu8qevlq99h";
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: {
        externalName: "1",
        state: "pending",
        endpoints: [],
        replayed: false,
        recovered: false,
      },
    }));
    const payer = payerWith(fetchImpl);
    await payer.create({ ...request(), allowProviders: [a, b, a] });
    expect(
      AkashTxCreateInputSchema.parse(calls[0]?.json).allowProviders
    ).toEqual([a, b]);
    await payer.create({ ...request(), cogniKey: "k2" });
    await payer.create({ ...request(), cogniKey: "k3", allowProviders: [] });
    for (const c of calls.slice(1))
      expect("allowProviders" in (c.json as Record<string, unknown>)).toBe(
        false
      );
  });

  it("never turns a requested allowlist of malformed accounts into NO allowlist: refuses before any call", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: {} }));
    await expect(
      payerWith(fetchImpl).create({
        ...request(),
        allowProviders: ["not-an-address"],
      })
    ).rejects.toMatchObject({ code: "invalid_request", ambiguous: false });
    expect(calls).toHaveLength(0);
  });

  it("a node-app spec with catalog countries and the DB CA wrapper passes the strict wire", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: {
        externalName: "1",
        state: "pending",
        endpoints: [],
        replayed: false,
        recovered: false,
      },
    }));
    await payerWith(fetchImpl).create({
      ...request(),
      spec: toPayerSpec(
        canaryApp(),
        { DATABASE_URL: "postgres://x", RELEASE_SHA: SHA_1 },
        { requiredCountryCodes: ["FI", "NL"], nodeApp: true }
      ),
    });
    const parsed = AkashTxCreateInputSchema.parse(calls[0]?.json);
    expect(parsed.spec.placement).toEqual({
      requiredCountryCodes: ["FI", "NL"],
    });
    expect(parsed.spec.services[0]?.command?.[0]).toBe("/bin/sh");
    expect(parsed.spec.services[0]?.args).toEqual(["sh", "-c", "echo app"]);
  });

  it("a state workload spec (persistent volume, tcp expose) also passes the strict wire", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: {
        externalName: "1",
        state: "active",
        endpoints: ["tcp://p.example:31000"],
        replayed: false,
        recovered: false,
      },
    }));
    await payerWith(fetchImpl).create({
      ...request(),
      spec: toPayerSpec(canaryDb(), { POSTGRES_PASSWORD: "x" }),
    });
    const parsed = AkashTxCreateInputSchema.parse(calls[0]?.json);
    expect(parsed.spec.services[0]?.volumes).toEqual([
      {
        name: "data",
        sizeMi: 2048,
        mountPath: "/var/lib/postgresql/data",
        tier: "nvme",
      },
    ]);
    expect(parsed.spec.placement).toBeUndefined();
  });

  it("observe and delete bodies pass their strict schemas", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith("/observe")
        ? {
            status: 200,
            body: {
              found: true,
              resource: { externalName: "9", state: "closed", endpoints: [] },
            },
          }
        : { status: 200, body: { deleted: true } }
    );
    const payer = payerWith(fetchImpl);
    const r = request();
    const o = await payer.observe({ cogniKey: r.cogniKey, externalName: "9" });
    await payer.delete({ cogniKey: r.cogniKey, externalName: "9" });
    expect(o).toEqual({
      found: true,
      resource: {
        externalName: "9",
        state: "closed",
        endpoints: [],
        providerAccount: undefined,
      },
    });
    expect(AkashTxObserveInputSchema.parse(calls[0]?.json).externalName).toBe(
      "9"
    );
    expect(AkashTxDeleteInputSchema.parse(calls[1]?.json).externalName).toBe(
      "9"
    );
  });

  it("observe found:false stays found:false", async () => {
    const { fetchImpl } = recorder(() => ({
      status: 200,
      body: { found: false },
    }));
    expect(await payerWith(fetchImpl).observe({ cogniKey: "k" })).toEqual({
      found: false,
    });
  });
});

describe("ActuatorPayer error classification", () => {
  const codeCase = async (status: number, code: string) => {
    const { fetchImpl } = recorder(() => ({
      status,
      body: { code, message: "m" },
    }));
    const err = await payerWith(fetchImpl)
      .create(request())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(PayerError);
    return err as PayerError;
  };

  it.each([
    [502, "outcome_unknown", true],
    [409, "allocation_unresolved", true],
    [409, "allocation_ambiguous", true],
    [409, "allocation_rolled_back", true],
    [502, "provider_unavailable", true],
    [503, "ledger_unavailable", true],
    [400, "invalid_request", false],
    [401, "unauthorized", false],
    [422, "provider_rejected", false],
    [422, "identity_conflict", false],
    [409, "wallet_allocation_blocked", false],
    [409, "placement_violated_by_incumbent", false],
  ])("%i %s -> ambiguous=%s", async (status, code, ambiguous) => {
    const err = await codeCase(status, code);
    expect(err.code).toBe(code);
    expect(err.ambiguous).toBe(ambiguous);
  });

  it("a network failure on a paid create is ambiguous; on observe it is not", async () => {
    const { fetchImpl } = recorder(() => new Error("socket hang up"));
    const payer = payerWith(fetchImpl);
    const created = (await payer
      .create(request())
      .catch((e: unknown) => e)) as PayerError;
    expect(created.code).toBe("network");
    expect(created.ambiguous).toBe(true);
    const observed = (await payer
      .observe({ cogniKey: "k" })
      .catch((e: unknown) => e)) as PayerError;
    expect(observed.code).toBe("network");
    expect(observed.ambiguous).toBe(false);
  });

  it("bug.5569: a create provider_rejected is definitive ONLY with the actuator's nothingBilling proof", async () => {
    const msgCase = async (
      status: number,
      code: string,
      message: string,
      extra: Record<string, unknown> = {}
    ) => {
      const { fetchImpl } = recorder(() => ({
        status,
        body: { code, message, ...extra },
      }));
      return (await payerWith(fetchImpl)
        .create(request())
        .catch((e: unknown) => e)) as PayerError;
    };
    // The reviewer's case: a Console 502 on the read-back AFTER the lease was allocated reached the
    // wire as provider_rejected. Without positive proof it is NOT definitive (the sequencer observes).
    const readBack = await msgCase(
      422,
      "provider_rejected",
      "Console request failed with HTTP 502"
    );
    expect(readBack).toMatchObject({
      code: "provider_rejected",
      ambiguous: false,
      definitive: false,
    });
    // Message text proves nothing either: a rolled-back-looking message with no field is not definitive.
    expect(
      (
        await msgCase(
          422,
          "provider_rejected",
          "none passed provider screening (deployment 9 closed, escrow refunding)"
        )
      ).definitive
    ).toBe(false);
    // With the field it is.
    expect(
      await msgCase(422, "provider_rejected", "allowlist empty", {
        nothingBilling: true,
      })
    ).toMatchObject({ ambiguous: false, definitive: true });
    // Only a literal `true` counts.
    for (const v of [false, "true", 1, null])
      expect(
        (await msgCase(422, "provider_rejected", "m", { nothingBilling: v }))
          .definitive
      ).toBe(false);
    // The field never makes another code definitive.
    for (const [status, code] of [
      [503, "ledger_unavailable"],
      [502, "outcome_unknown"],
      [422, "identity_conflict"],
      [400, "invalid_request"],
    ] as const)
      expect(
        (await msgCase(status, code, "m", { nothingBilling: true })).definitive
      ).toBe(false);
    // observe never reports definitive (it is not a create)
    const { fetchImpl } = recorder(() => ({
      status: 422,
      body: { code: "provider_rejected", message: "m", nothingBilling: true },
    }));
    const observed = (await payerWith(fetchImpl)
      .observe({ cogniKey: "k" })
      .catch((e: unknown) => e)) as PayerError;
    expect(observed.definitive).toBe(false);
  });

  it("an unknown 5xx is provider_unavailable (ambiguous); an unknown 4xx is invalid_request", async () => {
    expect((await codeCase(500, "weird")).ambiguous).toBe(true);
    expect((await codeCase(418, "weird")).code).toBe("invalid_request");
  });

  it("never puts the bearer token in an error message", async () => {
    const err = await codeCase(401, "unauthorized");
    expect(err.message).not.toContain("bearer-token-value");
  });
});
