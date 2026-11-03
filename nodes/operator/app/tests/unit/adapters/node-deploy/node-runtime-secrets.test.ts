// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/node-runtime-secrets`
 * Purpose: Prove the sequencer reads a node's runtime secrets through the EXISTING custody path
 *   (OpenBao -> ESO -> Secret): it is the one writer of ONE ExternalSecret `nd-<slug>-env` in its own
 *   namespace, waits a bounded time for Ready, drops denylisted keys, and never returns a half bucket
 *   (task.5405). The Kubernetes client is faked.
 * Side-effects: none
 */

import type { CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { EsoNodeRuntimeSecrets } from "@/adapters/server";
import { NodeRuntimeSecretsError } from "@/ports";
import { OFF_CLUSTER_WORKLOAD_DENIED_KEYS } from "@/shared/secrets/node-secrets-reserved.data";

const NS = "cogni-node-deploy-production";

type Cond = { type: string; status: string; reason?: string; message?: string };

function fake(
  opts: {
    secret?: Record<string, string> | undefined;
    /** Conditions the ExternalSecret reports after `readyAfterGets` reads (undefined = never). */
    conditions?: Cond[];
    readyAfterGets?: number;
    existing?: { spec: unknown; resourceVersion: string };
  } = {}
) {
  const calls: string[] = [];
  const created: unknown[] = [];
  const replaced: unknown[] = [];
  let gets = 0;
  let es: { spec: unknown; resourceVersion: string } | undefined =
    opts.existing;
  const err = (statusCode: number) =>
    Object.assign(new Error("k8s"), { statusCode });
  const custom = {
    async getNamespacedCustomObject(
      group: string,
      version: string,
      namespace: string,
      plural: string,
      name: string
    ) {
      calls.push(`get ${group}/${version} ${namespace}/${plural}/${name}`);
      if (!es) throw err(404);
      gets++;
      const ready = gets > (opts.readyAfterGets ?? 0);
      return {
        body: {
          metadata: { resourceVersion: es.resourceVersion },
          spec: es.spec,
          status: {
            conditions: ready ? (opts.conditions ?? []) : [],
          },
        },
      };
    },
    async createNamespacedCustomObject(
      _g: string,
      _v: string,
      namespace: string,
      _p: string,
      body: { metadata: { name: string }; spec: unknown }
    ) {
      calls.push(`create ${namespace}/${body.metadata.name}`);
      created.push(body);
      es = { spec: body.spec, resourceVersion: "1" };
      return {};
    },
    async replaceNamespacedCustomObject(
      _g: string,
      _v: string,
      namespace: string,
      _p: string,
      name: string,
      body: { metadata: { resourceVersion?: string }; spec: unknown }
    ) {
      calls.push(`replace ${namespace}/${name}`);
      replaced.push(body);
      es = { spec: body.spec, resourceVersion: "2" };
      return {};
    },
  } as unknown as CustomObjectsApi;
  const core = {
    async readNamespacedSecret(name: string, namespace: string) {
      calls.push(`secret ${namespace}/${name}`);
      if (!opts.secret) throw err(404);
      return {
        body: {
          data: Object.fromEntries(
            Object.entries(opts.secret).map(([k, v]) => [
              k,
              Buffer.from(v).toString("base64"),
            ])
          ),
        },
      };
    },
  } as unknown as CoreV1Api;
  let t = 0;
  const port = new EsoNodeRuntimeSecrets({
    namespace: NS,
    core,
    custom,
    readyTimeoutMs: 5_000,
    pollMs: 1_000,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  });
  return { port, calls, created, replaced };
}

const READY: Cond[] = [{ type: "Ready", status: "True" }];

describe("EsoNodeRuntimeSecrets", () => {
  it("creates nd-<slug>-env in its OWN namespace from the shared ClusterSecretStore, extracting <env>/<slug>", async () => {
    const f = fake({
      secret: { AUTH_SECRET: "a", PAPER_ENFORCE_MODE: "true" },
      conditions: READY,
    });
    // the first ensure finds nothing; the fake then serves the created object
    const out = await f.port.read("production", "poly", ["AUTH_SECRET"]);
    expect(out).toEqual({ AUTH_SECRET: "a", PAPER_ENFORCE_MODE: "true" });
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({
      apiVersion: "external-secrets.io/v1",
      kind: "ExternalSecret",
      metadata: { name: "nd-poly-env", namespace: NS },
      spec: {
        refreshInterval: "5m",
        secretStoreRef: { kind: "ClusterSecretStore", name: "openbao-backend" },
        target: { name: "nd-poly-env", creationPolicy: "Owner" },
        dataFrom: [{ extract: { key: "production/poly" } }],
      },
    });
    // every call stayed inside the sequencer's own namespace
    for (const c of f.calls) expect(c).toContain(NS);
    expect(f.calls.some((c) => c.startsWith("secret "))).toBe(true);
  });

  it("an unchanged ExternalSecret is not rewritten; a drifted one is replaced with its resourceVersion", async () => {
    const same = fake({
      existing: {
        spec: {
          refreshInterval: "5m",
          secretStoreRef: {
            kind: "ClusterSecretStore",
            name: "openbao-backend",
          },
          target: { name: "nd-poly-env", creationPolicy: "Owner" },
          dataFrom: [{ extract: { key: "production/poly" } }],
        },
        resourceVersion: "9",
      },
      secret: { AUTH_SECRET: "a" },
      conditions: READY,
    });
    await same.port.read("production", "poly", ["AUTH_SECRET"]);
    expect(same.created).toHaveLength(0);
    expect(same.replaced).toHaveLength(0);

    const drifted = fake({
      existing: { spec: { refreshInterval: "1h" }, resourceVersion: "9" },
      secret: { AUTH_SECRET: "a" },
      conditions: READY,
    });
    await drifted.port.read("production", "poly", ["AUTH_SECRET"]);
    expect(drifted.replaced).toHaveLength(1);
    expect(
      (drifted.replaced[0] as { metadata: { resourceVersion: string } })
        .metadata.resourceVersion
    ).toBe("9");
  });

  it("waits a bounded time for Ready, then reads", async () => {
    const f = fake({
      secret: { AUTH_SECRET: "a" },
      conditions: READY,
      readyAfterGets: 3,
    });
    await expect(
      f.port.read("production", "poly", ["AUTH_SECRET"])
    ).resolves.toEqual({ AUTH_SECRET: "a" });
  });

  it("never Ready within the bound is `unavailable` (the sequencer waits; nothing is read or paid)", async () => {
    const f = fake({ secret: { AUTH_SECRET: "a" }, conditions: [] });
    const err = await f.port
      .read("production", "poly", ["AUTH_SECRET"])
      .catch((e: unknown) => e);
    expect((err as NodeRuntimeSecretsError).code).toBe("unavailable");
    expect((err as Error).message).toBe("externalsecret not ready yet");
    expect(f.calls.some((c) => c.startsWith("secret "))).toBe(false);
  });

  it("Ready=False fails fast with ESO's reason and no values", async () => {
    const f = fake({
      secret: { AUTH_SECRET: "a" },
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "SecretSyncedError",
          message: "key production/poly not found",
        },
      ],
    });
    const err = await f.port
      .read("production", "poly", ["AUTH_SECRET"])
      .catch((e: unknown) => e);
    expect((err as NodeRuntimeSecretsError).code).toBe("unavailable");
    expect((err as Error).message).toContain("SecretSyncedError");
  });

  it("drops every denylisted key even if the bucket holds it, and skips empty values", async () => {
    const poisoned = Object.fromEntries(
      [...OFF_CLUSTER_WORKLOAD_DENIED_KEYS].map((k) => [k, "leak"])
    );
    const f = fake({
      secret: { AUTH_SECRET: "a", EMPTY: "", ...poisoned },
      conditions: READY,
    });
    const out = await f.port.read("production", "poly", ["AUTH_SECRET"]);
    expect(Object.keys(out)).toEqual(["AUTH_SECRET"]);
  });

  it("missing required keys throw missing_keys NAMING the keys, never values", async () => {
    const f = fake({
      secret: { AUTH_SECRET: "super-secret-value" },
      conditions: READY,
    });
    const err = await f.port
      .read("production", "poly", [
        "AUTH_SECRET",
        "EVM_RPC_URL",
        "DATABASE_URL",
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRuntimeSecretsError);
    expect((err as NodeRuntimeSecretsError).code).toBe("missing_keys");
    expect((err as NodeRuntimeSecretsError).keys).toEqual([
      "EVM_RPC_URL",
      "DATABASE_URL",
    ]);
    expect((err as Error).message).not.toContain("super-secret-value");
  });

  it("a required key that is only on the denylist counts as missing", async () => {
    const f = fake({
      secret: { LITELLM_MASTER_KEY: "fleet-master" },
      conditions: READY,
    });
    await expect(
      f.port.read("production", "poly", ["LITELLM_MASTER_KEY"])
    ).rejects.toMatchObject({ code: "missing_keys" });
  });

  it("a target Secret not rendered yet is `unavailable`", async () => {
    const f = fake({ conditions: READY });
    await expect(
      f.port.read("production", "poly", ["AUTH_SECRET"])
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses a slug that is not a plain node bucket name; no Kubernetes call is made", async () => {
    const f = fake({ secret: { AUTH_SECRET: "a" }, conditions: READY });
    for (const slug of [
      "operator",
      "_shared",
      "../operator",
      "A",
      "",
      "deadbeef-canary", // would shape-match a state password Secret
    ])
      await expect(
        f.port.read("production", slug, ["AUTH_SECRET"])
      ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.calls).toHaveLength(0);
  });
});
