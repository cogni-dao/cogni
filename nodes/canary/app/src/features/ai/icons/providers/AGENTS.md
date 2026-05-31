# providers · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Inline React SVG icon components for AI model providers. Enables theme-safe rendering with currentColor.

## Pointers

- [Parent: ai/icons](../../AGENTS.md)
- [Provider Icons Config](../../config/provider-icons.ts)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["shared"],
  "must_not_import": ["adapters", "core", "ports"]
}
```

## Public Surface

- **Exports:** OpenAIIcon, AnthropicIcon, QwenIcon, XAIIcon (React components)
- **Files considered API:** All .tsx files

## Responsibilities

- This directory **does**: provide inline SVG icon components with currentColor for theme compatibility
- This directory **does not**: implement icon selection logic or render icons directly

## Usage

```typescript
import { OpenAIIcon } from "@/features/ai/icons/providers/OpenAIIcon";
<OpenAIIcon className="h-4 w-4 text-foreground" />
```

## Standards

- All icons use currentColor for fills/strokes (theme-safe)
- No hardcoded colors or sizes
- viewBox preserved from source SVG
- aria-hidden and focusable=false for accessibility
- No SVGR or SVG imports (inline TSX only)

## Dependencies

- **Internal:** none
- **External:** react (SVGProps type)

## Change Protocol

- Update this file when providers added/removed
- Bump **Last reviewed** date

## Notes

- Icons derived from official provider brand assets
- Gradients simplified to currentColor for MVP
- Size controlled via className prop
