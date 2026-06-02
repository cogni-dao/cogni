// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useCollectEpoch`
 * Purpose: Client-side hook to trigger epoch collection on demand via POST /api/v1/attribution/epochs/collect.
 * Scope: Tracks loading + cooldown state for the trigger button. Does not access database or server-side logic.
 * Invariants: Server enforces session auth and cooldown.
 * Side-effects: IO (HTTP POST)
 * Links: src/app/api/v1/attribution/epochs/collect/route.ts
 * @public
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

export function useCollectEpoch() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const trigger = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCooldownSeconds(null);
    try {
      const res = await fetch("/api/v1/attribution/epochs/collect", {
        method: "POST",
        credentials: "same-origin",
      });

      if (res.status === 429) {
        const body = await res.json();
        setCooldownSeconds(body.retryAfterSeconds ?? 300);
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }

      void queryClient.invalidateQueries({ queryKey: ["governance"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  return { loading, error, cooldownSeconds, trigger };
}
