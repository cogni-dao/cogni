// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/server/node-admin-sync`
 * Purpose: Pin the `NODE_ADMIN_SYNC_WRITE` flag: default false (report-only), the ConfigMap string "true" parses to true.
 * Scope: Env schema parse only.
 * Invariants: REPORT_ONLY_BY_DEFAULT.
 * Side-effects: process.env (restored per test)
 * Links: src/shared/env/server-env.ts, infra/k8s/overlays/candidate-a/operator/kustomization.yaml, task.5494
 * @internal
 */

import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("NODE_ADMIN_SYNC_WRITE", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...BASE_VALID_ENV };
    delete process.env.NODE_ADMIN_SYNC_WRITE;
  });

  it("defaults to false: report-only", async () => {
    const { serverEnv } = await import("@/shared/env/server");
    expect(serverEnv().NODE_ADMIN_SYNC_WRITE).toBe(false);
  });

  it('parses the string "true" as true and "false" as false', async () => {
    process.env.NODE_ADMIN_SYNC_WRITE = "true";
    const on = await import("@/shared/env/server");
    expect(on.serverEnv().NODE_ADMIN_SYNC_WRITE).toBe(true);

    vi.resetModules();
    process.env.NODE_ADMIN_SYNC_WRITE = "false";
    const off = await import("@/shared/env/server");
    expect(off.serverEnv().NODE_ADMIN_SYNC_WRITE).toBe(false);
  });
});
