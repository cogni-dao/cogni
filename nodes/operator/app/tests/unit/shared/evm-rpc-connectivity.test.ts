// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/evm-rpc-connectivity`
 * Purpose: Prove shallow RPC probes are cached while explicit deep proof forces live Base IO.
 * Scope: Pure fake client; no network calls or environment mutation.
 * Invariants: SHALLOW_CACHE_BOUNDED, DEEP_PROOF_IS_LIVE.
 * Side-effects: module-local probe cache reset between tests
 * Links: src/shared/env/invariants.ts, bug.5175
 * @internal
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetEvmRpcConnectivityCacheForTest,
  checkEvmRpcConnectivity,
} from "@/shared/env/invariants";

const productionEnv = { APP_ENV: "production" } as never;

afterEach(() => {
  _resetEvmRpcConnectivityCacheForTest();
});

describe("checkEvmRpcConnectivity", () => {
  it("reuses a recent shallow success", async () => {
    const getBlockNumber = vi.fn(async () => 123n);

    await expect(
      checkEvmRpcConnectivity({ getBlockNumber }, productionEnv)
    ).resolves.toMatchObject({ ok: true, source: "live" });
    await expect(
      checkEvmRpcConnectivity({ getBlockNumber }, productionEnv)
    ).resolves.toMatchObject({ ok: true, source: "cached" });

    expect(getBlockNumber).toHaveBeenCalledOnce();
  });

  it("bypasses a recent success for explicit deep proof", async () => {
    const getBlockNumber = vi.fn(async () => 123n);

    await checkEvmRpcConnectivity({ getBlockNumber }, productionEnv);
    await expect(
      checkEvmRpcConnectivity({ getBlockNumber }, productionEnv, {
        forceLive: true,
      })
    ).resolves.toMatchObject({ ok: true, source: "live" });

    expect(getBlockNumber).toHaveBeenCalledTimes(2);
  });
});
