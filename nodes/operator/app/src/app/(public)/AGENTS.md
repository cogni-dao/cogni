# (public) · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Public pages wrapped in `AppHeader` + `AppFooter` shell. `/` redirects signed-in users to `/chat`; `/explore/nodes` is the public node gallery.

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
- **Routes:** `/` (homepage — redirects signed-in users to `/chat`), `/explore` (redirects to `/explore/nodes`), `/explore/nodes`, `/explore/nodes/[slug]`
- **Files considered API:** `layout.tsx`, `page.tsx`
- **Auth intent:** `AuthPrompt.client.tsx` opens the sign-in dialog only when `proxy.ts` redirects an app route to `/?signIn=1&callbackUrl=...`.

## Responsibilities

- This directory **does**: Render the public page shell (header + footer), expose public discovery pages, keep account chrome session-aware, and handle proxy-issued sign-in intents.
- This directory **does not**: Enforce authentication, render protected content, or decide protected-route policy.

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- Server-side redirect (`getServerSessionUser` + `redirect()`) is defense-in-depth for `/`; `proxy.ts` handles primary auth routing.
- Proxy.ts is the single authority for auth routing; `AuthPrompt.client.tsx` only handles the interactive sign-in transition after proxy redirects.
- No auth guard — pages render for unauthenticated visitors.

## Dependencies

- **Internal:** `@/features/layout` (AppHeader, AppFooter), `@/features/home` (HomeStats, NewHomeHero), `@/components/kit/auth` (SignInDialog), `@/lib/auth/server` (getServerSessionUser)
- **External:** next, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date

## Notes

- `AuthRedirect` was deleted in task.0111 — its client-side `useSession()` redirect caused loops with `(app)/layout.tsx`'s guard. Proxy.ts now handles auth routing; `AuthPrompt.client.tsx` only fulfills explicit sign-in intents.
