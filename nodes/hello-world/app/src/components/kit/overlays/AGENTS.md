# components/kit/overlays · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable
- **Parent:** [components/kit](../../../AGENTS.md)

## Purpose

Reusable kit components for overlay UI patterns including dialogs, modals, sheets, and tooltips.

## Pointers

- [Parent: Kit Components](../../../AGENTS.md)
- [UI Implementation Guide](../../../../../../docs/spec/ui-implementation.md)
- **Related:** [../data-display/](../data-display/) (ScrollArea used in Dialog)

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

- **Exports (via ../index.ts):** Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogFooter, DialogClose
- **Files considered API:** Dialog.tsx

## Responsibilities

- **This directory does:** Provide reusable overlay components with responsive behavior (mobile bottom-sheet, desktop modal)
- **This directory does not:** Implement feature logic, manage dialog state beyond open/close, or handle form validation

## Usage

```typescript
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/kit/overlays";

<Dialog>
  <DialogTrigger asChild>
    <button>Open Dialog</button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Dialog Title</DialogTitle>
    </DialogHeader>
    <div>Dialog content...</div>
  </DialogContent>
</Dialog>
```

## Standards

- Vendor isolation: Only kit may import from components/vendor
- Responsive by default (mobile bottom-sheet, desktop centered modal)
- Semantic tokens only (no hardcoded colors)
- Controlled or uncontrolled via open/onOpenChange props
- Export through parent index.ts
- Accessibility: focus trap, escape key, click outside to close

## Dependencies

- **Internal:** @/components/vendor/shadcn/dialog, @/shared/util/cn
- **External:** react, @radix-ui/react-dialog

## Change Protocol

- Update parent index.ts when adding new overlay component exports
- Breaking prop changes require major version consideration
- Keep vendor wrappers thin (delegate to vendor)

## Notes

- Dialog uses Radix UI primitives via shadcn vendor wrapper
- Responsive behavior: bottom-sheet on mobile (<sm), centered modal on desktop
- DialogContent accepts className for layout customization
- Model selection dialog (features/ai) uses Dialog + ScrollArea composition
- Future: Sheet, Popover, Tooltip components planned
