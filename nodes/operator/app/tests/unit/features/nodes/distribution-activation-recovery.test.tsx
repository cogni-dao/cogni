// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests for distribution activation browser recovery.
 * Purpose: Pin hash-only persistence, identity namespacing, hydration, and duplicate guards.
 * Scope: Browser-local pure parsing and hook behavior with mocked browser state; no RPC or wallet.
 * Side-effects: jsdom localStorage and navigator.locks override, restored between tests.
 * Links: src/features/nodes/distribution-activation-recovery.ts
 */

// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ActivationRecoveryIdentity,
  activationRecoveryStorageKey,
  hasDownstreamEvidenceWithoutDistributor,
  parseActivationRecovery,
  useDistributionActivationRecovery,
} from "@/features/nodes/distribution-activation-recovery";

const HASH_A = `0x${"1".repeat(64)}` as const;
const HASH_B = `0x${"2".repeat(64)}` as const;
const IDENTITY: ActivationRecoveryIdentity = {
  nodeId: "dist-e2e-0818",
  chainId: 8453,
  tokenAddress: "0x1111111111111111111111111111111111111111",
  daoAddress: "0x2222222222222222222222222222222222222222",
  publisherAddress: "0x3333333333333333333333333333333333333333",
};

describe("distribution activation recovery", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("namespaces public hashes by node, chain, token, DAO, and publisher", () => {
    const key = activationRecoveryStorageKey(IDENTITY);
    expect(key).toContain("dist-e2e-0818");
    expect(key).toContain("8453");
    expect(key).toContain(IDENTITY.tokenAddress.toLowerCase());
    expect(key).toContain(IDENTITY.daoAddress.toLowerCase());
    expect(key).toContain(IDENTITY.publisherAddress.toLowerCase());
  });

  it("parses only version-one transaction hashes", () => {
    expect(
      parseActivationRecovery(
        JSON.stringify({
          version: 1,
          hashes: {
            deployDistributor: HASH_A,
            transferOwnership: "not-a-hash",
            secret: "must-not-survive",
          },
        })
      )
    ).toEqual({ deployDistributor: HASH_A });
    expect(
      parseActivationRecovery(
        JSON.stringify({ version: 2, hashes: { deployDistributor: HASH_A } })
      )
    ).toEqual({});
  });

  it("blocks a deploy when only downstream recovery evidence is known", () => {
    expect(
      hasDownstreamEvidenceWithoutDistributor({
        hashes: { transferOwnership: HASH_B },
        distributorVerified: false,
      })
    ).toBe(true);
    expect(
      hasDownstreamEvidenceWithoutDistributor({
        hashes: { grantPermission: HASH_B },
        distributorVerified: false,
      })
    ).toBe(true);
    expect(
      hasDownstreamEvidenceWithoutDistributor({
        hashes: { deployDistributor: HASH_A, grantPermission: HASH_B },
        distributorVerified: false,
      })
    ).toBe(false);
    expect(
      hasDownstreamEvidenceWithoutDistributor({
        hashes: { deployCondition: HASH_B },
        distributorVerified: true,
      })
    ).toBe(false);
  });

  it("hydrates and persists only the public hash record", async () => {
    const { result } = renderHook(() =>
      useDistributionActivationRecovery(IDENTITY)
    );
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => result.current.setHash("deployDistributor", HASH_A));
    act(() => result.current.setHash("transferOwnership", HASH_B));

    const stored = window.localStorage.getItem(
      activationRecoveryStorageKey(IDENTITY)
    );
    expect(JSON.parse(stored ?? "null")).toEqual({
      version: 1,
      hashes: {
        deployDistributor: HASH_A,
        transferOwnership: HASH_B,
      },
    });
  });

  it("blocks same-render duplicates but propagates wallet execution failures", async () => {
    const { result } = renderHook(() =>
      useDistributionActivationRecovery(IDENTITY)
    );
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    let finish: (value: string) => void = () => {
      throw new Error("guarded action did not start");
    };
    const first = result.current.runGuarded(
      "deployDistributor",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    await expect(
      result.current.runGuarded("deployDistributor", async () => "duplicate")
    ).resolves.toBeUndefined();
    finish("started");
    await expect(first).resolves.toBe("started");

    await expect(
      result.current.runGuarded("transferOwnership", async () => {
        throw new Error("User rejected request");
      })
    ).rejects.toThrow("User rejected request");
  });

  it("honors a live fallback lease from another tab", async () => {
    const { result } = renderHook(() =>
      useDistributionActivationRecovery(IDENTITY)
    );
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const lockKey = `${activationRecoveryStorageKey(IDENTITY)}:lock:grantPermission`;
    window.localStorage.setItem(
      lockKey,
      JSON.stringify({ token: "other-tab", expiresAt: Date.now() + 60_000 })
    );
    await expect(
      result.current.runGuarded("grantPermission", async () => "started")
    ).resolves.toBeUndefined();
  });
});
