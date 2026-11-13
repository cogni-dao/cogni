# (app) · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Protected (authenticated) pages wrapped in `SidebarProvider` + `AppSidebar` + `AppTopBar` shell. Auth is enforced at `src/proxy.ts`; page-level server guards may remain as defense-in-depth on legacy routes.

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
- **Routes:** `/chat`, `/dashboard`, `/work`, `/work/items/[id]`, `/activity`, `/knowledge`, `/metrics`, `/gov`, `/credits`, `/nodes`, `/schedules`, `/schedules/[scheduleId]`, `/setup`, `/identity/attest`
- **Files considered API:** `layout.tsx`

## Responsibilities

- This directory **does**: Render the sidebar layout shell (sidebar + top bar + content area) for routes protected by `src/proxy.ts`. It also mounts the one entry side sheet (`EntityPeekProvider`) that linked knowledge entries open in (bug.0011).
- This directory **does not**: Handle sign-in/sign-out flows, contain business logic, manage session persistence.

## Package mounts

- `/work` reads bounded pages only (task.0056): the board is `useWorkBoard` over `/api/v1/work/board`, the table is `useWorkTablePage` over `/api/v1/work/summaries`; nothing here walks cursors.
- The Knowledge Goals tab renders only the published `@cogni/knowledge-base-ui/goals` board through `knowledge/_components/GoalsMount.tsx` (story.0021); the app owns no Goals markup, chart or formatter.
- `/metrics` (story.0016) renders the published `MetricsBoard` (goals, then KPIs, then metrics, drawn with the shared `MetricCard`) through `metrics/_components/MetricsMount.tsx`; every Goals mount (Metrics page, Knowledge Goals tab, work views) shares `_components/goals-host.ts`, so the goal read is one cache entry.
- `/work` wraps the dashboard in `WorkGoalsMount` (task.0112): the table's Goal column, the board's goal pointer and the detail sheet's Moves block (`WorkMoveLinks`, `WorkExpectations` over `/api/v1/work/items/[id]/expectations`) resolve goals from that one read.

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- Auth routing lives in `src/proxy.ts`. Keep the proxy route list aligned with every `(app)` top-level route.
- Unauthenticated users are redirected to `/`. No auto sign-out — sign-out is an explicit user action.
- The sidebar logo links to `/chat`, not `/`.

## Dependencies

- **Internal:** `@/components` (SidebarProvider, SidebarInset), `@/features/layout` (AppSidebar, AppTopBar), `@/features/ai` (chat page, thread hooks)
- **External:** next, next-auth/react, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date

## Notes

- `SidebarProvider` sets a `sidebar_state` cookie for collapse persistence.
- Chat thread state bridges to the sidebar via Zustand store (`useChatSidebarStore`), not React context, because the sidebar is a sibling of page content.
