# (public) · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Public pages wrapped in `AppHeader` + `AppFooter` shell. `/` redirects signed-in users to `/chat`; `/nodes` remains public but renders auth-aware account chrome.

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)

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
- **Routes:** `/` (homepage — redirects signed-in users to `/chat`), `/nodes`, `/nodes/[slug]`
- **Files considered API:** `layout.tsx`, `page.tsx`
- **Deleted:** `AuthRedirect.tsx` — replaced by server-side proxy routing

## Responsibilities

- This directory **does**: Render the public page shell (header + footer), expose public discovery pages, and keep account chrome session-aware.
- This directory **does not**: Handle authentication, render protected content, manage session state, perform client-side redirects.

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- Server-side redirect (`getServerSessionUser` + `redirect()`) is defense-in-depth for `/`; `proxy.ts` handles primary auth routing.
- No client-side auth redirects — proxy.ts is the single authority for auth routing.
- No auth guard — pages render for unauthenticated visitors.

## Dependencies

- **Internal:** `@/features/layout` (AppHeader, AppFooter), `@/features/home` (HomeStats, NewHomeHero), `@/lib/auth/server` (getServerSessionUser)
- **External:** next, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date

## Notes

- `AuthRedirect` was deleted in task.0111 — its client-side `useSession()` redirect caused loops with `(app)/layout.tsx`'s guard. Proxy.ts now handles all auth routing server-side.
