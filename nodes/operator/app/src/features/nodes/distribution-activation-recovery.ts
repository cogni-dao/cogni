// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/distribution-activation-recovery`
 * Purpose: Browser-local recovery hints and duplicate-execution guards for one-time distribution
 *   activation. Only public transaction hashes are persisted; receipts and contract state are
 *   always reconstructed and verified from the configured chain before the ceremony advances.
 * Scope: Versioned localStorage cache, cross-tab subscription, manual hash recovery, and a short
 *   action lock around wallet submission. No server state, secrets, contract writes, or authority.
 * Invariants:
 *   - CHAIN_IS_AUTHORITY: cached values are hints, never proof and never trigger a wallet action.
 *   - HASHES_ONLY: values contain exactly the four public transaction hashes and a schema version.
 *   - FULLY_NAMESPACED: node, chain, token, DAO, and publisher form the cache and lock namespace.
 *   - FAIL_CLOSED: malformed/unavailable storage becomes an empty hydrated snapshot.
 * Side-effects: browser localStorage, storage events, Web Locks when supported.
 * Links: src/features/nodes/DistributionsCard.client.tsx,
 *   src/features/nodes/useDeployDistributor.ts,
 *   src/features/governance/hooks/useAuthorizePublishing.ts
 * @public
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isHash } from "viem";

const CACHE_PREFIX = "cogni:distribution-activation:v1";
const CACHE_VERSION = 1 as const;
const FALLBACK_LOCK_TTL_MS = 120_000;

export type ActivationTransactionKey =
  | "deployDistributor"
  | "transferOwnership"
  | "deployCondition"
  | "grantPermission";

export type ActivationTransactionHashes = Partial<
  Readonly<Record<ActivationTransactionKey, `0x${string}`>>
>;

export interface ActivationRecoveryIdentity {
  readonly nodeId: string;
  readonly chainId: number;
  readonly tokenAddress: `0x${string}`;
  readonly daoAddress: `0x${string}`;
  readonly publisherAddress: `0x${string}`;
}

interface StoredActivationRecovery {
  readonly version: typeof CACHE_VERSION;
  readonly hashes: ActivationTransactionHashes;
}

export type ActivationActionGuard = <T>(
  action: ActivationTransactionKey,
  execute: () => Promise<T>
) => Promise<T | undefined>;

function normalizePart(value: string): string {
  return encodeURIComponent(value.toLowerCase());
}

export function activationRecoveryStorageKey(
  identity: ActivationRecoveryIdentity
): string {
  return [
    CACHE_PREFIX,
    normalizePart(identity.nodeId),
    identity.chainId,
    normalizePart(identity.tokenAddress),
    normalizePart(identity.daoAddress),
    normalizePart(identity.publisherAddress),
  ].join(":");
}

function parseHashes(value: unknown): ActivationTransactionHashes {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const hashes: Partial<Record<ActivationTransactionKey, `0x${string}`>> = {};
  const keys: readonly ActivationTransactionKey[] = [
    "deployDistributor",
    "transferOwnership",
    "deployCondition",
    "grantPermission",
  ];
  for (const key of keys) {
    const hash = source[key];
    if (typeof hash === "string" && isHash(hash)) hashes[key] = hash;
  }
  return hashes;
}

export function parseActivationRecovery(
  raw: string | null
): ActivationTransactionHashes {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<StoredActivationRecovery>;
    if (parsed.version !== CACHE_VERSION) return {};
    return parseHashes(parsed.hashes);
  } catch {
    return {};
  }
}

/** Later hashes without deploy/address proof are a duplicate-deploy hazard, never a fresh setup. */
export function hasDownstreamEvidenceWithoutDistributor(params: {
  readonly hashes: ActivationTransactionHashes;
  readonly distributorVerified: boolean;
}): boolean {
  const { hashes, distributorVerified } = params;
  if (hashes.deployDistributor || distributorVerified) return false;
  return Boolean(
    hashes.transferOwnership || hashes.deployCondition || hashes.grantPermission
  );
}

function readRecovery(storageKey: string): ActivationTransactionHashes {
  try {
    return parseActivationRecovery(window.localStorage.getItem(storageKey));
  } catch {
    return {};
  }
}

function writeRecovery(
  storageKey: string,
  hashes: ActivationTransactionHashes
): void {
  const value: StoredActivationRecovery = {
    version: CACHE_VERSION,
    hashes,
  };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Recovery is best-effort. Chain evidence remains authoritative when storage is unavailable.
  }
}

function fallbackLockIsLive(raw: string | null, now: number): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { expiresAt?: unknown };
    return typeof parsed.expiresAt === "number" && parsed.expiresAt > now;
  } catch {
    return false;
  }
}

export interface DistributionActivationRecovery {
  readonly hydrated: boolean;
  readonly hashes: ActivationTransactionHashes;
  readonly setHash: (
    key: ActivationTransactionKey,
    hash: `0x${string}`
  ) => void;
  readonly replaceHashes: (hashes: ActivationTransactionHashes) => void;
  readonly runGuarded: ActivationActionGuard;
}

/** Hydrate and synchronize one fully namespaced public-hash recovery record. */
export function useDistributionActivationRecovery(
  identity: ActivationRecoveryIdentity | null
): DistributionActivationRecovery {
  const storageKey = useMemo(
    () => (identity ? activationRecoveryStorageKey(identity) : null),
    [identity]
  );
  const [hydratedStorageKey, setHydratedStorageKey] = useState<string | null>(
    null
  );
  const [hashes, setHashes] = useState<ActivationTransactionHashes>({});
  const inFlight = useRef(new Set<ActivationTransactionKey>());

  useEffect(() => {
    setHydratedStorageKey(null);
    setHashes({});
    if (!storageKey) return;
    setHashes(readRecovery(storageKey));
    setHydratedStorageKey(storageKey);

    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        setHashes(parseActivationRecovery(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const replaceHashes = useCallback(
    (next: ActivationTransactionHashes) => {
      if (!storageKey) return;
      const valid = parseHashes(next);
      setHashes(valid);
      writeRecovery(storageKey, valid);
    },
    [storageKey]
  );

  const setHash = useCallback(
    (key: ActivationTransactionKey, hash: `0x${string}`) => {
      if (!storageKey || !isHash(hash)) return;
      setHashes((current) => {
        const next = { ...current, [key]: hash };
        writeRecovery(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const runGuarded = useCallback<ActivationActionGuard>(
    async (action, execute) => {
      if (!storageKey || inFlight.current.has(action)) return undefined;
      inFlight.current.add(action);
      const lockName = `${storageKey}:lock:${action}`;
      try {
        if (navigator.locks) {
          return await navigator.locks.request(
            lockName,
            { ifAvailable: true },
            async (lock) => (lock ? execute() : undefined)
          );
        }

        const now = Date.now();
        const token = `${now}:${Math.random().toString(36).slice(2)}`;
        try {
          const existing = window.localStorage.getItem(lockName);
          if (fallbackLockIsLive(existing, now)) return undefined;
          window.localStorage.setItem(
            lockName,
            JSON.stringify({ token, expiresAt: now + FALLBACK_LOCK_TTL_MS })
          );
          await Promise.resolve();
          const acquired = window.localStorage.getItem(lockName);
          if (!acquired?.includes(token)) return undefined;
        } catch {
          return undefined;
        }
        try {
          return await execute();
        } finally {
          try {
            if (window.localStorage.getItem(lockName)?.includes(token)) {
              window.localStorage.removeItem(lockName);
            }
          } catch {
            // Lock expiry is the fallback cleanup when storage becomes unavailable mid-action.
          }
        }
      } finally {
        inFlight.current.delete(action);
      }
    },
    [storageKey]
  );

  return {
    hydrated: storageKey !== null && hydratedStorageKey === storageKey,
    hashes,
    setHash,
    replaceHashes,
    runGuarded,
  };
}
