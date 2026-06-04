# features/layout · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft
- **Parent:** [features](../AGENTS.md)

## Purpose

App-shell layout components: header, footer, sidebar, and top bar. Composes kit/vendor UI primitives into the authenticated and public page shells.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [UI Implementation Guide](../../../../../docs/spec/ui-implementation.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["components", "contracts", "shared", "features"],
  "must_not_import": ["app", "adapters", "core", "ports", "styles"]
}
```

## Public Surface

- **Exports:** `AppHeader`, `AppFooter`, `AppSidebar`, `AppTopBar` via `index.ts`
- **Files considered API:** `index.ts`

## Responsibilities

- This directory **does**: Compose layout shells from kit components, provide sidebar navigation, render top bar with wallet/treasury/theme controls.
- This directory **does not**: Handle authentication, fetch data, contain business logic, define design tokens.

## Usage

```bash
pnpm lint
pnpm build
```

## Standards

- All vendor/shadcn imports must go through `@/components` barrel — never import vendor paths directly.
- Sidebar tokens (`sidebar-*`) are part of the design system (registered in ESLint allowlist).
- `AppSidebar` uses Zustand store (`useChatSidebarStore`) to bridge chat thread state from the chat page — sidebar is a sibling of content, not an ancestor.

## Dependencies

- **Internal:** `@/components` (sidebar, sheet, button, etc.), `@/features/ai/chat/components` (ChatSidebarContext, ChatThreadsSidebarGroup), `@/features/treasury` (TreasuryBadge), `@/contracts` (ThreadSummary type)
- **External:** lucide-react, next/image, next/link, next/navigation

## Change Protocol

- Update this file when **Exports** change
- Bump **Last reviewed** date
- Ensure `pnpm lint` passes (vendor isolation + token rules)

## Notes

- `AppHeader` is used in `(public)` layout; `AppSidebar` + `AppTopBar` are used in `(app)` layout.
- Chat thread state bridged via Zustand because sidebar is a sibling of page content, not an ancestor (React context wouldn't work).
