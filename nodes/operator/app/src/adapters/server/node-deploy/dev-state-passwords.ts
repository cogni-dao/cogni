// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/dev-state-passwords`
 * Purpose: DEV-ONLY `SecretsPort`: one 0600 file per state workload under a local directory (task.5400).
 * Scope: used only by `scripts/node-deploy-local.ts`, imported by path.
 * Invariants:
 *   - NOT_IN_THE_BARREL: deliberately in its own file and NOT exported from `@/adapters/server`, so the
 *     production sequencer bootstrap cannot reach it (asserted by dev-adapters-not-in-prod.test.ts and
 *     by the artifact smoke, which greps the bundle).
 *   - CREATE_ONCE: `flag: "wx"`; an existing password is returned, never overwritten.
 * Side-effects: filesystem
 * @internal
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SecretsPort, WorkloadKey } from "@/ports";

import { secretName } from "./state-secrets.adapter";

const generate = (): string => randomBytes(32).toString("base64url");

/** DEV ONLY: one 0600 file per `(env, workload)`. Selected explicitly by the dev bootstrap. */
export class FileStatePasswords implements SecretsPort {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private file(key: WorkloadKey): string {
    return join(this.dir, `${secretName(key)}-${key.env}`);
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
