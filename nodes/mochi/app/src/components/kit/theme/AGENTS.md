# src/components/kit/theme · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek
- **Status:** stable

## Purpose

Theme switching UI components. Provides SheetThemeToggle for mobile navigation and integrates with next-themes.

## Pointers

- [Root AGENTS.md](../../../../../../AGENTS.md)
- [ModeToggle](../inputs/ModeToggle.tsx) - Dropdown-based theme toggle for desktop

## Boundaries

```json
{
  "layer": "components",
  "may_import": ["shared"],
  "must_not_import": ["features", "core", "ports", "adapters"]
}
```

## Public Surface

- **Exports:**
  - `SheetThemeToggle` - Inline 3-button theme toggle for mobile Sheet navigation
- **Files considered API:** `SheetThemeToggle.tsx`

## Responsibilities

- This directory **does**: Provide inline theme switching UI for mobile Sheet footer with 3-button toggle-group
- This directory **does not**: Manage theme persistence (next-themes handles); implement toggle primitives (shadcn/toggle-group); handle desktop theme UI (see ModeToggle in inputs/)

## Usage

```tsx
import { SheetThemeToggle } from "@/components/kit/theme/SheetThemeToggle";

// In Sheet footer
<div className="mt-auto border-t pt-4">
  <SheetThemeToggle />
</div>;
```

## Standards

- Components must be client-side ("use client")
- Use next-themes useTheme() hook
- Prevent hydration mismatch with mounted state
- Touch targets ≥ 48px (h-12)

## Dependencies

- **Internal:** shadcn toggle-group primitive (vendor)
- **External:** `next-themes`, `lucide-react`

## Change Protocol

- Update this file when **Public Surface** changes (new exports)
- Bump **Last reviewed** date
- Ensure theme toggle maintains grid layout and accessibility

## Notes

- SheetThemeToggle uses grid-cols-3 to fill Sheet width (w-48 sm:w-52)
- Each button is h-12 w-full (48px touch target, equal width)
- Icons only (Sun/Moon/Monitor), no text labels
- Alternative to ModeToggle dropdown for Sheet footer context
