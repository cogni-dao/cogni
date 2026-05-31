# styles · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek
- **Status:** stable

## Purpose

Design system with single token pipeline: colors in CSS vars, spacing/sizing in Tailwind config, CVA factories for components.

## Pointers

## Boundaries

```json
{
  "layer": "styles",
  "may_import": ["styles"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters/server",
    "adapters/worker",
    "contracts",
    "bootstrap",
    "shared",
    "components",
    "types"
  ]
}
```

## Public Surface

- **Exports:** Design token name arrays, TypeScript types, CVA styling factories
- **Files considered API:** ui.ts, ui/index.ts, theme.ts

## Responsibilities

- This directory **does**: Export token name constants for TypeScript usage, provide CVA styling factories for components
- This directory **does not**: Define token values (CSS is source of truth), contain component logic

## Usage

Minimal local commands:

```bash
pnpm typecheck
```

## Standards

- **Token pipeline (CSS-first)**: Colors + fonts + spacing + z-index → `@theme inline` block → Tailwind utilities; Runtime theme vars (:root/.dark) mapped via `hsl(var(--name))` pattern
- **Tailwind v4 CSS-first**: Uses `@theme inline`, `@utility`, `@custom-variant` directives; no JS config file
- **Layout dimensions**: `--app-header-h` defines header height; `.chat-viewport` utility provides viewport height minus header
- **Dropdown widths**: Use CSS custom property syntax `w-(--dropdown-sm)` instead of theme tokens
- CVA factories use Tailwind classes (gap-4, h-icon-lg, z-overlay) - no var() refs except approved hero animation tokens, dropdown widths, and layout dimensions
- theme.ts exports only token keys and types for CVA variant props
- All component styling flows through ui.ts barrel (re-exports from ui/ domain modules)

## Dependencies

- **Internal:** none
- **External:** class-variance-authority (for CVA factories)

## Change Protocol

- Update this file when **Exports** change
- Bump **Last reviewed** date
- Token names must match CSS variables in src/styles/tailwind.css
- CVA factory changes require updating components that use them

## Notes

- CSS is source of truth for all design token values
- ui.ts barrel is the single source of truth for component styling API
- Domain-split architecture: ui.ts re-exports from ui/ domain modules (inputs.ts, data.ts, layout.ts, typography.ts, overlays.ts)
- ESLint blocks literal className usage to enforce API discipline
- CVA parameters (e.g., `gap: "xs"`) are allowed; direct literals (e.g., `className="flex"`) are blocked
- Terminal components (src/features/home/components/Terminal.tsx, src/components/kit/data-display/TerminalFrame.tsx) serve as reference implementation for CVA-only patterns

### Architecture: Domain-Split CVA Factories

```
src/styles/
  ui.ts          # barrel export (21 LOC) - backward compatibility
  ui/
    index.ts     # explicit re-exports from domain modules
    inputs.ts    # button factories
    data.ts      # card, badge, avatar factories
    layout.ts    # container, section, grid, row, pad factories
    typography.ts # heading, paragraph, prose, prompt factories
    overlays.ts  # terminal, icon, reveal factories
    payments.ts  # payment flow status, container, step factories
```

**Rules:** CVA-only, token classes only, no literals outside styles/. ESLint scope applies to `src/styles/ui/**/*.ts`. Individual ui/ domain modules manage their own growth - see ui/AGENTS.md for further splitting guidance.
