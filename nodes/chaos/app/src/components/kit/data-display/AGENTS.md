# components/kit/data-display · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable
- **Parent:** [components/kit](../../../AGENTS.md)

## Purpose

Reusable kit components for displaying data including badges, avatars, scroll areas, terminal frames, activity charts, and shared provider brand icons.

## Pointers

- [Parent: Kit Components](../../../AGENTS.md)
- [UI Implementation Guide](../../../../../../docs/spec/ui-implementation.md)
- **Related:** [../overlays/](../overlays/) (Dialog uses ScrollArea)

## Boundaries

```json
{
  "layer": "components",
  "may_import": ["shared", "types"],
  "must_not_import": [
    "app",
    "features",
    "adapters",
    "core",
    "ports",
    "contracts"
  ]
}
```

## Public Surface

- **Exports (via ../index.ts):** ActivityChart, Avatar, Badge, DiscordIcon, EthereumIcon, ExpandableTableRow, GitHubIcon, GoogleIcon, GithubButton, ProviderIconProps, ScrollArea, TerminalFrame
- **Files considered API:** All \*.tsx files in this directory

## Responsibilities

- **This directory does:** Provide reusable, styled components for data display with semantic tokens
- **This directory does not:** Implement feature logic, manage state (beyond local UI state), or make API calls

## Usage

```typescript
import { ScrollArea, Badge, Avatar } from "@/components/kit/data-display";

// ScrollArea - wrapper for vendor scroll-area with kit styling
<ScrollArea className="h-[400px]">
  <div>Scrollable content...</div>
</ScrollArea>

// Badge - status indicator
<Badge variant="success">Active</Badge>

// Avatar - user/entity representation
<Avatar src="/avatar.png" alt="User" />
```

## Standards

- Vendor isolation: Only kit may import from components/vendor
- Semantic tokens only (no hardcoded colors)
- Minimal props (className for composition)
- No feature logic or business rules
- Export through parent index.ts

## Dependencies

- **Internal:** @/components/vendor/shadcn (for ScrollArea, chart, card), @/shared/util/cn
- **External:** react, lucide-react (icons), @radix-ui/\* (primitives)

## Change Protocol

- Update parent index.ts when adding/removing component exports
- Breaking prop changes require major version consideration
- Keep vendor wrappers thin (delegate to vendor)

## Notes

- ScrollArea wraps shadcn scroll-area with kit styling defaults
- Badge supports variants: default, success, warning, error
- Avatar handles loading states and fallbacks
- GithubButton is a specialized display component for repo links
- TerminalFrame provides styled container for terminal output
