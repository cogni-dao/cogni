# features/ai/preferences · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable
- **Parent:** [features/ai](../AGENTS.md)

## Purpose

Client-side user preferences persistence for AI feature using localStorage with SSR-safe access patterns.

## Pointers

- [Parent: AI Feature](../AGENTS.md)
- **Related:** [../components/](../components/) (ChatComposerExtras)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["core", "ports", "shared", "types", "components", "contracts"],
  "must_not_import": ["app", "adapters"]
}
```

## Public Surface

- **Exports (via ../public.ts):** getPreferredModelId, setPreferredModelId, clearPreferredModelId, validatePreferredModel
- **Files considered API:** model-preference.ts

## Responsibilities

- **This directory does:** Provide localStorage utilities for persisting user preferences with graceful degradation
- **This directory does not:** Implement UI, manage React state, or validate against server-side allowlist (delegates validation helper to consumer)

## Usage

```typescript
import {
  getPreferredModelId,
  setPreferredModelId,
  validatePreferredModel,
} from "@/features/ai/public";

// Read preference
const storedModelId = getPreferredModelId(); // null if not set or SSR

// Write preference
setPreferredModelId("gpt-4o-mini"); // Fails silently on error

// Validate stored preference against available models
const validatedModelId = validatePreferredModel(
  availableModelIds,
  defaultModelId
); // Returns stored if valid, defaultModelId otherwise
```

## Standards

- All localStorage operations wrapped in try/catch
- SSR guards (typeof window check)
- Graceful degradation (return null on read errors, silent on write errors)
- Single storage key: "cogni.chat.preferredModelId"
- Client-only module (never import in server components)

## Dependencies

- **Internal:** none
- **External:** none (pure browser APIs)

## Change Protocol

- Update parent public.ts when adding new preference utilities
- Update parent AGENTS.md when public surface changes
- Storage key changes require migration logic

## Notes

- localStorage may fail in Safari private mode or when quota exceeded
- Validation helper (validatePreferredModel) clears invalid stored values
- No React state management (pure utilities)
- Consumer responsible for calling validate after fetching available models
