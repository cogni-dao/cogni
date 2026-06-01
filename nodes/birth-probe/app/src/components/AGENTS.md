# components · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Shared presentational UI. No business logic, no data fetching. Design tokens and variants only.

## Pointers

- [Architecture](../../../../docs/spec/architecture.md)
- [UI Implementation Guide](../../../../docs/spec/ui-implementation.md)

## Boundaries

```json
{
  "layer": "components",
  "may_import": ["components", "shared", "types", "styles"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters/server",
    "adapters/worker",
    "contracts",
    "bootstrap"
  ]
}
```

## Public Surface

- **Exports:** UI components and widgets via `components/index.ts`
- **Files considered API:** `index.ts`, `kit/*/index.tsx`

## Responsibilities

- This directory **does**: Presentational UI, tokens, themes, CVA variants, local UI state only.
- This directory **does not**: Domain rules, DB/IO, network calls, adapter logic.

## Usage

**IMPORTANT: If you are making any changes to files in this directory, you must read:** [`docs/spec/ui-implementation.md`](../../../../docs/spec/ui-implementation.md)

Minimal local commands:

```bash
pnpm typecheck
pnpm lint
```

## Standards

```
src/components/
  vendor/ui-primitives/  # vendored primitives. do not edit. do not export.
    shadcn/              # shadcn/ui components (alert, progress)
  kit/                   # wrappers only. className for layout only.
    layout/              # Container, Section, Grid
    inputs/              # Button, Input, Select, Switch
    data-display/        # Card(+parts), Badge, Avatar(+parts)
    navigation/          # Tabs, Breadcrumbs, Pagination
    feedback/            # Alert, Progress, ToastPresenter
    payments/            # UsdcPaymentFlow (3-state payment UI)
    typography/          # Heading, Paragraph
    auth/                # WalletConnectButton
    animation/           # Reveal
    sections/            # Hero, CtaSection, FeaturesGrid
    mdx/                 # Prose, mdx components map
  icons/                 # app SVGs
  index.ts               # curated exports from kit only
```

- **Placement Rules:**
  - Single-route or one-off → keep colocated with that route or in `features/<slice>/components/`.
  - Reused by ≥2 slices → promote to `components/kit/`.
  - Stateless + generic → `components/kit/`.
  - shadcn-generated files → stay in `vendor/ui-primitives/shadcn/` unmodified; wrap in kit/ to customize.
- **Styling:** Use tokens from `src/styles/` only. No arbitrary Tailwind values. Prefer CVA for variants. Variant props must be typed. No inline styles except approved CSS vars. Kit components accept typed props from theme.ts and call CVAs; no className.
- **Testing:** Snapshot widgets and critical primitives. No network. Client-only tests isolate interactivity.

## Dependencies

- **Internal:** shared/util, styles/
- **External:** React, Radix UI primitives, class-variance-authority

## Change Protocol

- Update **Last reviewed** and this file when exports or subdir rules change.
- Run boundary lint. Refuse merges that import outside `may_import`.

## Notes

- Promotion policy: colocate → second consumer → promote. Keep root lean.
- Each file: short header with Purpose, Scope, Invariants. No inline commentary drift.
- Implementation workflows live in `docs/spec/ui-implementation.md`.
