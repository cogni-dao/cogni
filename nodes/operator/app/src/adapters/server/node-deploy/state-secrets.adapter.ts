// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/state-secrets.adapter`
 * Purpose: Where the sequencer keeps the GENERATED state-workload password (task.5400): a Kubernetes
 *   Secret `nd-<nodeId8>-<workload>` in a DEDICATED per-env namespace (`cogni-node-deploy-<env>`) that
 *   holds nothing else, or a 0600 file under a local directory (dev only, the local harness).
 * Scope: get + create-once. Never update, never delete, never list.
 * Invariants:
 *   - CREATE_ONCE_REUSE_AFTER: `ensureStatePassword` creates the secret if absent and otherwise returns
 *     the stored value; a 409 on create (a racing writer) re-reads and returns the winner's value.
 *   - NEVER_OVERWRITE: a password that already guards live data must never be replaced.
 *   - NO_SECRETS_IN_THE_WALLET_NAMESPACE: the namespace is injected and is NEVER the pod's own namespace
 *     (the bootstrap refuses to boot if they are equal); the Role that allows get/create lives in that
 *     dedicated namespace only. `LEAST_KUBERNETES_PRIVILEGE` in the actuator's namespace stays intact.
 *   - NODE_IS_IN_THE_NAME: the secret name carries the first 8 hex of the node id, so two nodes that
 *     both declare a `db` workload can never share one password. A request for another env is refused.
 *   - GENERATED_256_BIT: 32 random bytes, base64url.
 *   - NO_VALUES_IN_LOGS: nothing here logs a value.
 * Side-effects: IO (Kubernetes API or local filesystem)
 * @internal
 */

import { randomBytes } from "node:crypto";

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

import type { SecretsPort, WorkloadKey } from "@/ports";

/** `nd-<nodeId8>-<workload>`; the env is the namespace, not part of the name. */
export const secretName = (key: WorkloadKey): string =>
  `nd-${key.nodeId.replace(/-/g, "").slice(0, 8)}-${key.workload}`.toLowerCase();

const generate = (): string => randomBytes(32).toString("base64url");

export class KubernetesStatePasswords implements SecretsPort {
  private readonly core: CoreV1Api;
  constructor(
    private readonly namespace: string,
    private readonly env: string,
    core?: CoreV1Api
  ) {
    if (core) this.core = core;
    else {
      const kc = new KubeConfig();
      kc.loadFromCluster();
      this.core = kc.makeApiClient(CoreV1Api);
    }
  }

  async getStatePassword(key: WorkloadKey): Promise<string | undefined> {
    if (key.env !== this.env)
      throw new Error(`state secret for env ${key.env} is not served here`);
    try {
      const res = await this.core.readNamespacedSecret(
        secretName(key),
        this.namespace
      );
      const raw = res.body.data?.password;
      return raw ? Buffer.from(raw, "base64").toString("utf8") : undefined;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404)
        return undefined;
      throw error;
    }
  }

  async ensureStatePassword(key: WorkloadKey): Promise<string> {
    const existing = await this.getStatePassword(key);
    if (existing) return existing;
    const password = generate();
    try {
      await this.core.createNamespacedSecret(this.namespace, {
        metadata: {
          name: secretName(key),
          labels: {
            "app.kubernetes.io/managed-by": "node-deploy-sequencer",
            "app.kubernetes.io/part-of": "cogni",
          },
        },
        type: "Opaque",
        stringData: { password },
      });
      return password;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 409) {
        const winner = await this.getStatePassword(key);
        if (winner) return winner;
      }
      throw error;
    }
  }
}
