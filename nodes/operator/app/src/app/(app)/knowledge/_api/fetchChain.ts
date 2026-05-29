// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchChain`
 * Purpose: Client-side fetch wrapper for the EDO chain walk.
 * Scope: Calls GET /api/v1/edo/chain/:id with same-origin credentials.
 * Invariants: Cookie-session only — never sends a Bearer header.
 * Side-effects: IO
 * Links: docs/spec/knowledge-syntropy.md § Chain Read API
 * @internal
 */

export type ChainDirection = "out" | "in" | "both";

export interface ChainEntryDto {
  id: string;
  domain: string;
  entityId: string | null;
  title: string;
  content: string;
  confidencePct: number | null;
  sourceType: string;
  sourceRef: string | null;
  tags: string[] | null;
}

export interface ChainNodeDto {
  entry: ChainEntryDto;
  edgeFromParent: { citationType: string; direction: "out" | "in" } | null;
  depth: number;
}

export interface ChainResponse {
  root: ChainEntryDto;
  chain: ChainNodeDto[];
}

export async function fetchChain(
  rootId: string,
  opts?: { direction?: ChainDirection; maxDepth?: number }
): Promise<ChainResponse> {
  const params = new URLSearchParams();
  params.set("direction", opts?.direction ?? "both");
  if (opts?.maxDepth !== undefined) {
    params.set("maxDepth", String(opts.maxDepth));
  }
  const url = `/api/v1/edo/chain/${encodeURIComponent(rootId)}?${params.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Failed to fetch chain" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<ChainResponse>;
}
