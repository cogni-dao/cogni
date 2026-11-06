// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/mesh-keys.adapter`
 * Purpose: Where the sequencer keeps ONE attempt's Headscale pre-auth key (task.5431, hub
 *   node-service-delivery section 3): a create-once Kubernetes Secret
 *   `nd-<nodeId8>-<workload>-mesh-<releaseId>-a<attempt>` in the lane's dedicated
 *   `cogni-node-deploy-<env>` namespace, the merged state-secret precedent (`state-secrets.adapter.ts`).
 * Scope: get, create-once and delete by name. Never update, never list.
 * Invariants:
 *   - CREATE_ONCE: a 409 on create re-reads and returns the winner's value; nothing is overwritten.
 *   - NAME_IS_ADMISSIBLE: every name must match `MESH_ATTEMPT_SECRET_NAME_RE`, the admission policy's delete
 *     allow-list (PR #3042), so this adapter can never read, write or delete a state password.
 *   - DELETE_IS_IDEMPOTENT: a 404 on delete is success. The sequencer deletes only one pass after the
 *     attempt's revoke is read back.
 *   - NO_SECRETS_IN_THE_WALLET_NAMESPACE: the namespace is the lane's secrets namespace, never the pod's.
 *   - NO_VALUES_IN_LOGS: nothing here logs; an error never carries the value.
 * Side-effects: IO (Kubernetes API)
 * @internal
 */

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

import {
  headscaleKeyId,
  MESH_ATTEMPT_SECRET_NAME_RE,
  type MeshKeyStorePort,
  type StoredMeshKey,
} from "@/ports";

const statusOf = (error: unknown): number | undefined =>
  (error as { statusCode?: number; code?: number }).statusCode ??
  (error as { code?: number }).code;

const admissible = (name: string): string => {
  if (!MESH_ATTEMPT_SECRET_NAME_RE.test(name))
    throw new Error(`not an attempt mesh secret name: ${name}`);
  return name;
};

export class KubernetesMeshKeys implements MeshKeyStorePort {
  private readonly core: CoreV1Api;
  constructor(
    private readonly namespace: string,
    core?: CoreV1Api
  ) {
    if (core) this.core = core;
    else {
      const kc = new KubeConfig();
      kc.loadFromCluster();
      this.core = kc.makeApiClient(CoreV1Api);
    }
  }

  async get(name: string): Promise<StoredMeshKey | undefined> {
    try {
      const res = await this.core.readNamespacedSecret(
        admissible(name),
        this.namespace
      );
      const data = res.body.data ?? {};
      const key = data.key ? Buffer.from(data.key, "base64").toString() : "";
      const id = data.headscaleKeyId
        ? Buffer.from(data.headscaleKeyId, "base64").toString()
        : "";
      return key && id
        ? { key, headscaleKeyId: headscaleKeyId(id) }
        : undefined;
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw error;
    }
  }

  async createOnce(name: string, value: StoredMeshKey): Promise<StoredMeshKey> {
    try {
      await this.core.createNamespacedSecret(this.namespace, {
        metadata: {
          name: admissible(name),
          labels: {
            "app.kubernetes.io/managed-by": "node-deploy-sequencer",
            "app.kubernetes.io/part-of": "cogni",
            "cogni.dev/secret-kind": "mesh-attempt-key",
          },
        },
        type: "Opaque",
        stringData: { key: value.key, headscaleKeyId: value.headscaleKeyId },
      });
      return value;
    } catch (error) {
      if (statusOf(error) === 409) {
        const winner = await this.get(name);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret(admissible(name), this.namespace);
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw error;
    }
  }
}
