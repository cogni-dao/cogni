# styles/ui · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Domain-split CVA styling factories organized by component type for maintainable design system API.

## Pointers

- [Parent styles AGENTS.md](../AGENTS.md)
- [UI Implementation Guide](../../../../../docs/spec/ui-implementation.md)

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

- **Exports:** CVA factories via index.ts barrel, variant types
- **Files considered API:** index.ts (barrel), all domain .ts files

## Responsibilities

- This directory **does**: Organize CVA factories by component domain, provide typed variant exports, maintain explicit barrel exports
- This directory **does not**: Contain CSS values, component logic, or cross-domain dependencies

## Usage

```bash
pnpm typecheck
```

## Standards

### Domain Organization

```
ui/
  inputs.ts      # button, input, select, switch, form controls
  data.ts        # card(+parts), badge, avatar(+parts), tables, lists
  layout.ts      # container, section, grid, row, pad, spacing utils
  typography.ts  # heading, paragraph, prose, prompt, text styling
  overlays.ts    # terminal, modal, dialog, popover, toast, icons
  index.ts       # explicit re-exports (no export *)
```

### Growth Management

**Current sizes (Nov 2025):** inputs.ts(49), data.ts(110), layout.ts(132), typography.ts(99), overlays.ts(111)

**When any domain file exceeds ~200 LOC, split by sub-domain:**

**inputs.ts** → `inputs/buttons.ts`, `inputs/forms.ts`, `inputs/controls.ts`  
**data.ts** → `data/cards.ts`, `data/badges.ts`, `data/tables.ts`  
**overlays.ts** → `overlays/modals.ts`, `overlays/terminals.ts`, `overlays/icons.ts`

**Process:** Create subdirectory, move factories to sub-domain files, update index.ts exports, maintain backward compatibility.

## Dependencies

- **Internal:** none (isolated domain modules)
- **External:** class-variance-authority

## Change Protocol

- Update **Last reviewed** when adding/removing domain files
- Maintain explicit exports in index.ts (no export \*)
- Each domain file must export its own variant types
- Cross-domain factory dependencies are prohibited

## Notes

- Each .ts file follows same header standards as parent styles/
- CVA-only rule applies to all files in this directory
- ESLint no-literal-classnames enforced at `ui/**/*.ts` scope
- Barrel pattern maintains single import path: `@/styles/ui`
