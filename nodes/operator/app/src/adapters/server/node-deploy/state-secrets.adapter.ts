// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/state-secrets.adapter`
 * Purpose: Where the sequencer keeps the GENERATED state-workload password (task.5400): a Kubernetes
 *   Secret `nd-<workload>-<env>` in the sequencer's own namespace (production), or a 0600 file under a
 *   local directory (dev only, selected by the dev bootstrap).
 * Scope: get + create-once. Never update, never delete, never list.
 * Invariants:
 *   - CREATE_ONCE_REUSE_AFTER: `ensureStatePassword` creates the secret if absent and otherwise returns
 *     the stored value; a 409 on create (a racing writer) re-reads and returns the winner's value.
 *   - NEVER_OVERWRITE: a password that already guards live data must never be replaced.
 *   - GENERATED_256_BIT: 32 random bytes, base64url.
 *   - NO_VALUES_IN_LOGS: nothing here logs a value.
 * Side-effects: IO (Kubernetes API or local filesystem)
 * @internal
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

import type { SecretsPort, WorkloadKey } from "@/ports";

const secretName = (key: WorkloadKey): string =>
  `nd-${key.workload}-${key.env}`.toLowerCase();

const generate = (): string => randomBytes(32).toString("base64url");

export class KubernetesStatePasswords implements SecretsPort {
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

  async getStatePassword(key: WorkloadKey): Promise<string | undefined> {
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

/** DEV ONLY: one 0600 file per `(env, workload)`. Selected explicitly by the dev bootstrap. */
export class FileStatePasswords implements SecretsPort {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private file(key: WorkloadKey): string {
    return join(this.dir, secretName(key));
  }
  async getStatePassword(key: WorkloadKey): Promise<string | undefined> {
    try {
      return readFileSync(this.file(key), "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  async ensureStatePassword(key: WorkloadKey): Promise<string> {
    const existing = await this.getStatePassword(key);
    if (existing) return existing;
    const password = generate();
    writeFileSync(this.file(key), password, { mode: 0o600, flag: "wx" });
    return password;
  }
}
