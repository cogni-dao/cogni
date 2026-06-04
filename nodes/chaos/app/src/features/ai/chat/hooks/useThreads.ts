// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/hooks/useThreads`
 * Purpose: React Query hooks for thread list, load, and delete operations.
 * Scope: Client-side data fetching for thread sidebar. Does not manage thread switching state.
 * Invariants: All fetches use cache: "no-store". Query keys are stable for invalidation.
 * Side-effects: IO (fetch); React Query cache.
 * Links: src/contracts/ai.threads.v1.contract.ts
 * @public
 */

import type {
  ListThreadsOutput,
  LoadThreadOutput,
} from "@cogni/node-contracts";
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

const THREADS_KEY = "ai-threads";
const THREAD_KEY = "ai-thread";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch thread list for the authenticated user. */
export function useThreads(
  opts: { limit?: number; offset?: number } = {}
): UseQueryResult<ListThreadsOutput, Error> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();

  return useQuery({
    queryKey: [THREADS_KEY, opts],
    queryFn: () =>
      fetchJson<ListThreadsOutput>(`/api/v1/ai/threads${qs ? `?${qs}` : ""}`),
    staleTime: 10_000, // 10s — threads update infrequently
  });
}

/** Fetch full messages for a thread. Enabled only when stateKey is provided. */
export function useLoadThread(
  stateKey: string | null | undefined
): UseQueryResult<LoadThreadOutput, Error> {
  return useQuery({
    queryKey: [THREAD_KEY, stateKey],
    queryFn: () =>
      fetchJson<LoadThreadOutput>(
        `/api/v1/ai/threads/${encodeURIComponent(stateKey as string)}`
      ),
    enabled: !!stateKey,
    staleTime: 30_000,
  });
}

/** Soft-delete a thread. Invalidates the thread list on success. */
export function useDeleteThread(): UseMutationResult<
  { ok: true },
  Error,
  string
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (stateKey: string) =>
      fetchJson<{ ok: true }>(
        `/api/v1/ai/threads/${encodeURIComponent(stateKey)}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [THREADS_KEY] });
    },
  });
}
