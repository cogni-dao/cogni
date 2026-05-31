# features/ai/components · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable
- **Parent:** [features/ai](../AGENTS.md)

## Purpose

Feature-specific UI components for AI model selection and chat composer extensions. Not reusable kit primitives.

## Pointers

- [Parent: AI Feature](../AGENTS.md)
- [Kit Chat Components](../../../components/kit/chat/)
- **Related:** [../hooks/](../hooks/) (useModels), [../preferences/](../preferences/) (localStorage), [../config/](../config/) (icons)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["core", "ports", "shared", "types", "components", "contracts"],
  "must_not_import": ["app", "adapters"]
}
```

## Public Surface

- **Exports (via ../public.ts):** ModelPicker, ChatComposerExtras
- **Files considered API:** ModelPicker.tsx, ChatComposerExtras.tsx

## Responsibilities

- **This directory does:** Provide feature-specific UI for model selection dialog and chat composer toolbar extensions
- **This directory does not:** Implement reusable kit primitives, manage API state (delegates to hooks), handle localStorage (delegates to preferences)

## Usage

```typescript
import { ModelPicker, ChatComposerExtras } from "@/features/ai/public";

// Model picker (controlled component)
<ModelPicker
  models={modelsQuery.data?.models ?? []}
  value={selectedModel}
  onValueChange={setSelectedModel}
/>

// Composer extras (smart component with hooks)
<ChatComposerExtras
  selectedModel={selectedModel}
  onModelChange={setSelectedModel}
  defaultModelId={defaultModelId}
/>
```

## Standards

- Use kit primitives (Dialog, ScrollArea) for layout
- Delegate state management to parent components
- Feature-specific styling (not reusable patterns)
- Export through parent public.ts only

## Dependencies

- **Internal:** @/components/kit/\*, @/components/vendor/shadcn, @/contracts/ai.models.v1.contract, ../hooks/useModels, ../preferences/model-preference, ../config/provider-icons
- **External:** lucide-react, react

## Change Protocol

- Update parent public.ts when adding/removing exports
- Update parent AGENTS.md when public surface changes
- Component API changes require consumer updates

## Notes

- ModelPicker is a controlled component (no internal state)
- ChatComposerExtras is a smart component (manages localStorage sync)
- Both designed for chat composer toolbar (composerLeft slot)
