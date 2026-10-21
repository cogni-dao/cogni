// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/_api/fetchCitationLinks`
 * Purpose: Client-side fetch wrapper for depth-1 citation links on a knowledge
 *   or work-item endpoint.
 * Scope: Browser fetch only. Does not implement citation policy.
 * Side-effects: IO
 * @internal
 */

export interface CitationEndpointDto {
  readonly id: string;
  readonly kind: "knowledge" | "work";
  readonly title: string | null;
  readonly href: string;
}

export interface CitationLinkDto {
  readonly id: string;
  readonly direction: "out" | "in";
  readonly citationType: string;
  readonly source: CitationEndpointDto;
  readonly target: CitationEndpointDto;
  readonly context: string | null;
}

export interface CitationLinksResponse {
  readonly links: CitationLinkDto[];
  readonly nextCursor: string | null;
}

export async function fetchCitationLinks(
  id: string,
  cursor?: string
): Promise<CitationLinksResponse> {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set("cursor", cursor);
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetch(
    `/api/v1/citations/${encodeURIComponent(id)}${suffix}`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch citation links",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<CitationLinksResponse>;
}
