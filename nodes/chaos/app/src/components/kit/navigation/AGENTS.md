# src/components/kit/navigation · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek
- **Status:** stable

## Purpose

Navigation UI components for mobile and desktop. Provides NavigationLink with active route detection and MobileNav Sheet drawer.

## Pointers

- [Root AGENTS.md](../../../../../../AGENTS.md)
- [UI Implementation Guide](../../../../../../docs/spec/ui-implementation.md)

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
  - `NavigationLink` - Next.js Link wrapper with active route detection
  - `MobileNav` - Sheet-based mobile navigation (md:hidden)
- **Files considered API:** `NavigationLink.tsx`, `MobileNav.tsx`

## Responsibilities

- This directory **does**: Provide navigation UI components with responsive behavior; mobile Sheet drawer with inline theme toggle; active route indication
- This directory **does not**: Handle routing logic; manage theme persistence (next-themes); implement Sheet primitives (vendor/shadcn)

## Usage

```tsx
import { NavigationLink, MobileNav } from "@/components";

<nav>
  <NavigationLink href="/chat">Chat</NavigationLink>
  <NavigationLink href="/credits">Credits</NavigationLink>
</nav>

<MobileNav className="md:hidden" />
```

## Standards

- Components must be client-side ("use client")
- NavigationLink uses usePathname for active detection
- MobileNav requires SheetTitle for accessibility (WCAG 2.1)
- Touch targets ≥ 40px (h-10 minimum)

## Dependencies

- **Internal:** shadcn Sheet primitive (vendor), SheetThemeToggle (kit/theme)
- **External:** `lucide-react`, `next/link`, `next/navigation`

## Change Protocol

- Update this file when **Public Surface** changes (new exports)
- Bump **Last reviewed** date
- Ensure new components maintain responsive breakpoints and accessibility

## Notes

- MobileNav Sheet width (w-48 sm:w-52) matches 3-column theme toggle grid
- GitHub link in Sheet is simple external link (not GithubButton widget)
- Theme toggle pinned to Sheet footer with mt-auto (OpenRouter-style)
- NavigationLink supports exact/prefix match modes for active state
