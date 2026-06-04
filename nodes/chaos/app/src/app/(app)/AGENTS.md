# (app) · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Protected (authenticated) pages wrapped in `SidebarProvider` + `AppSidebar` + `AppTopBar` shell. Auth enforced by layout-level `useSession()` guard — all child routes require authentication.

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [Layout Feature](../../features/layout/AGENTS.md)

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
- **Routes:** `/chat`, `/dashboard`, `/work`, `/activity`, `/gov`, `/credits`, `/schedules`, `/setup`
- **Files considered API:** `layout.tsx`

## Responsibilities

- This directory **does**: Enforce authentication via `useSession()` redirect, render the sidebar layout shell (sidebar + top bar + content area).
- This directory **does not**: Handle sign-in/sign-out flows, contain business logic, manage session persistence.

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- Auth guard lives in `layout.tsx` only. Do NOT add per-page auth checks.
- Unauthenticated users are redirected to `/`. No auto sign-out — sign-out is an explicit user action.
- Sidebar navigation links stay within `(app)` routes. The sidebar logo links to `/chat`, not `/`.

## Dependencies

- **Internal:** `@/components` (SidebarProvider, SidebarInset), `@/features/layout` (AppSidebar, AppTopBar), `@/features/ai` (chat page, thread hooks)
- **External:** next, next-auth/react, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date

## Notes

- `SidebarProvider` sets a `sidebar_state` cookie for collapse persistence.
- Chat thread state bridges to the sidebar via Zustand store (`useChatSidebarStore`), not React context, because the sidebar is a sibling of page content.
