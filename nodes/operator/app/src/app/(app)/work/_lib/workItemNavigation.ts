// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_lib/workItemNavigation`
 * Purpose: Builds and applies route-backed work-item navigation while preserving list state.
 * Scope: Pure URL/history policy; no React or IO.
 * Invariants: Selection pushes for browser Back; close replaces to avoid a reopen loop.
 * Side-effects: router history mutation through the supplied interface
 * Links: bug.5355, ../view.tsx
 * @internal
 */

type SerializableSearchParams = Pick<URLSearchParams, "toString">;
type WorkRouter = {
  push(href: string, options: { scroll: boolean }): void;
  replace(href: string, options: { scroll: boolean }): void;
};

export function workListHref(searchParams: SerializableSearchParams): string {
  const query = searchParams.toString();
  return query ? `/work?${query}` : "/work";
}

export function workItemHref(
  id: string,
  searchParams: SerializableSearchParams
): string {
  const query = searchParams.toString();
  const path = `/work/items/${encodeURIComponent(id)}`;
  return query ? `${path}?${query}` : path;
}

export function openWorkItemPermalink(
  router: WorkRouter,
  id: string,
  searchParams: SerializableSearchParams
): void {
  router.push(workItemHref(id, searchParams), { scroll: false });
}

export function closeWorkItemPermalink(
  router: WorkRouter,
  searchParams: SerializableSearchParams
): void {
  router.replace(workListHref(searchParams), { scroll: false });
}
