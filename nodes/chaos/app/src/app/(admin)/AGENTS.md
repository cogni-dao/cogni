# (admin) · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Last reviewed:** 2026-05-30
- **Status:** draft

## Purpose

DAO-admin route group. Server-rendered pages that require the SIWE session
wallet to be in the repo-spec approver allowlist
(`activity_ledger.approvers`). Wraps DAO ownership, DAO setup, and future
admin-only surfaces in one role-gated shell.

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Approver guard pattern (API)](../api/v1/attribution/_lib/approver-guard.ts)
- [Repo-spec accessor](../../shared/config/repoSpec.server.ts)
- [Multi-tenant + route-group research](../../../../../docs/research/node-scaling-multitenant-strategy.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "shared", "components", "contracts"],
  "must_not_import": ["adapters", "core", "ports"]
}
```

## Public Surface

- **Exports:** none
- **Routes:** `/admin` (index linking to admin-only surfaces such as `/gov/review`)
- **Files considered API:** `layout.tsx`, `admin/page.tsx`

## Auth contract

- **Login gate** — `proxy.ts` matcher includes `/admin/:path*`; unauthenticated
  visitors are redirected to `/`.
- **Admin gate** — `layout.tsx` (server component) reads
  `getServerSessionUser()` + `getLedgerApprovers()`. Non-approvers are
  redirected to `/dashboard`.
- **No UI-only gating.** Hiding nav links is a UX hint; the server gate is
  the security boundary.
- **Address comparison is case-insensitive** (lowercase both sides).

## Responsibilities

- This directory **does**: host pages that require approver-wallet access.
- This directory **does not**: duplicate logic that already exists under
  `(app)/`; link to it instead. New admin surfaces should reuse existing
  hooks (e.g. `useSignEpoch`) rather than re-implementing signing flows.

## Adding an admin page

1. Drop a `page.tsx` (server component preferred) under `(admin)/<feature>/`.
2. Trust the layout's gate — do **not** re-check `getLedgerApprovers()` per
   page unless the page handles non-admin states intentionally.
3. Link from `(admin)/admin/page.tsx` so the admin index discovers it.
4. If the page needs an API mutation, ensure the corresponding API route
   uses `checkApprover()` from
   `@/app/api/v1/attribution/_lib/approver-guard`.

## Standards

- Server components by default; mark client components with `"use client"`
  only when interaction needs it.
- No business logic in pages; delegate to features/hooks.
- No direct DB access.

## Change Protocol

- Update this file when the auth contract or shell composition changes.
- Bump **Last reviewed** date.
- Update `(app)/AGENTS.md` "Route Group Conventions" if adding a new group
  semantic.

## Notes

- `(admin)/page.tsx` would collide with `(public)/page.tsx` (both resolve to
  `/`). The admin index lives at `(admin)/admin/page.tsx` → `/admin`.
- `AdminShell` mirrors `(app)/layout.tsx` so admin and app routes share
  the same sidebar + topbar visuals; the auth guard is the only
  meaningful divergence.
