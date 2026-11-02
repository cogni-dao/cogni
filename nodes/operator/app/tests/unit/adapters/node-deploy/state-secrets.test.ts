// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/state-secrets`
 * Purpose: The generated state password is create-once, named per node, namespaced away from the wallet
 *   namespace, and never served across envs (task.5400 review).
 * Side-effects: none (the Kubernetes client is faked)
 */

import type { CoreV1Api } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { KubernetesStatePasswords } from "@/adapters/server";
import { secretName } from "../../../../src/adapters/server/node-deploy/state-secrets.adapter";

const NODE_A = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const NODE_B = "9aa11bb2-1111-4111-8111-111111111111";
const key = (nodeId = NODE_A, env = "production", workload = "canary-db") => ({
  nodeId,
  env,
  workload,
});

function fakeCore(opts: { raceOnCreate?: boolean } = {}) {
  const store = new Map<string, string>();
  const calls: { op: string; namespace: string; name: string }[] = [];
  const err = (statusCode: number) =>
    Object.assign(new Error("k8s"), { statusCode });
  const core = {
    async readNamespacedSecret(name: string, namespace: string) {
      calls.push({ op: "read", namespace, name });
      const v = store.get(`${namespace}/${name}`);
      if (v === undefined) throw err(404);
      return {
        body: { data: { password: Buffer.from(v).toString("base64") } },
      };
    },
    async createNamespacedSecret(
      namespace: string,
      body: { metadata: { name: string }; stringData: { password: string } }
    ) {
      calls.push({ op: "create", namespace, name: body.metadata.name });
      const k = `${namespace}/${body.metadata.name}`;
      if (opts.raceOnCreate) {
        store.set(k, "winner-password");
        throw err(409);
      }
      if (store.has(k)) throw err(409);
      store.set(k, body.stringData.password);
      return {};
    },
  } as unknown as CoreV1Api;
  return { core, store, calls };
}

describe("KubernetesStatePasswords", () => {
  it("names the secret nd-<nodeId8>-<workload> so two nodes can never share one", () => {
    expect(secretName(key())).toBe("nd-4ff8eac1-canary-db");
    expect(secretName(key(NODE_B))).toBe("nd-9aa11bb2-canary-db");
    expect(secretName(key(NODE_A))).not.toBe(secretName(key(NODE_B)));
  });

  it("creates once in the DEDICATED namespace, reuses after, and never touches another namespace", async () => {
    const { core, calls } = fakeCore();
    const secrets = new KubernetesStatePasswords(
      "cogni-node-deploy-production",
      "production",
      core
    );
    const first = await secrets.ensureStatePassword(key());
    const second = await secrets.ensureStatePassword(key());
    expect(second).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    expect(calls.filter((c) => c.op === "create")).toHaveLength(1);
    expect(new Set(calls.map((c) => c.namespace))).toEqual(
      new Set(["cogni-node-deploy-production"])
    );
    expect(new Set(calls.map((c) => c.name))).toEqual(
      new Set(["nd-4ff8eac1-canary-db"])
    );
  });

  it("a racing writer's 409 returns the WINNER's value (never overwrites)", async () => {
    const { core } = fakeCore({ raceOnCreate: true });
    const secrets = new KubernetesStatePasswords(
      "cogni-node-deploy-production",
      "production",
      core
    );
    expect(await secrets.ensureStatePassword(key())).toBe("winner-password");
  });

  it("refuses a key for an env it does not serve, before any API call", async () => {
    const { core, calls } = fakeCore();
    const secrets = new KubernetesStatePasswords(
      "cogni-node-deploy-production",
      "production",
      core
    );
    await expect(
      secrets.getStatePassword(key(NODE_A, "preview"))
    ).rejects.toThrow(/not served here/);
    await expect(
      secrets.ensureStatePassword(key(NODE_A, "preview"))
    ).rejects.toThrow(/not served here/);
    expect(calls).toEqual([]);
  });

  it("an absent secret reads as undefined, not an error", async () => {
    const { core } = fakeCore();
    const secrets = new KubernetesStatePasswords(
      "cogni-node-deploy-production",
      "production",
      core
    );
    expect(await secrets.getStatePassword(key())).toBeUndefined();
  });
});
