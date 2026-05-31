# components/kit/chat · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable
- **Parent:** [components/kit](../../../AGENTS.md)

## Purpose

Reusable kit wrappers for chat UI components with vendor isolation and composition slots for feature extensions.

## Pointers

- [Parent: Kit Components](../../../AGENTS.md)
- [Chat Feature](../../../features/ai/chat/AGENTS.md)
- [UI Implementation Guide](../../../../../../docs/spec/ui-implementation.md)
- **Related:** [../../vendor/assistant-ui/](../../vendor/assistant-ui/) (vendor primitives)

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

- **Exports (via index.ts and ../index.ts):** Thread, ComposerAddAttachment, ComposerVoiceInput
- **Files considered API:** Thread.tsx, ComposerAddAttachment.tsx, ComposerVoiceInput.tsx, index.ts

## Responsibilities

- **This directory does:** Provide vendor-isolated wrappers for assistant-ui components with composition slots and semantic token styling
- **This directory does not:** Implement chat runtime, state management, message persistence, or feature-specific logic (model selection, credits hints)

## Usage

```typescript
import { Thread } from "@/components/kit/chat";
import { ChatComposerExtras } from "@/features/ai/public";

// Thread with composerLeft slot for feature extensions
<Thread
  welcomeMessage={<CustomWelcome />}
  composerLeft={
    <ChatComposerExtras
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      defaultModelId={defaultModelId}
    />
  }
/>

// ComposerAddAttachment - styled attachment button
<ComposerAddAttachment />
```

## Standards

- Vendor isolation: Only kit may import from components/vendor
- No feature logic (use composition slots for feature extensions)
- Vendor components remain pristine (no edits to assistant-ui code)
- Semantic tokens only (no hardcoded colors)
- Composition over configuration (slots for extensions)
- Export through parent index.ts

## Dependencies

- **Internal:** @/components/vendor/assistant-ui/\*, @/shared/util/cn
- **External:** react, @assistant-ui/react, lucide-react

## Change Protocol

- Update index.ts and parent index.ts when adding component exports
- Slot API changes require consumer updates
- Keep vendor wrappers thin (delegate to vendor)
- Never edit vendor component files directly

## Notes

- Thread provides composerLeft slot for toolbar extensions (model picker, etc.)
- Slot positioned via CSS overlay to avoid vendor component edits
- ComposerAddAttachment overrides vendor styling with semantic accent tokens
- ComposerVoiceInput wraps ComposerPrimitive.Dictate/StopDictation for voice-to-text (progressive enhancement — hidden when no DictationAdapter configured)
- Vendor Thread component (`@/components/vendor/assistant-ui/thread`) remains unmodified
- composerLeft slot uses pointer-events CSS to allow clicks through overlay
