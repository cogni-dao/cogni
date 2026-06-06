# features/ai/config · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable
- **Parent:** [features/ai](../AGENTS.md)

## Purpose

Configuration and static data for AI feature including provider icon registry for model selection UI.

## Pointers

- [Parent: AI Feature](../AGENTS.md)
- **Related:** [../components/](../components/) (ModelPicker)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["core", "ports", "shared", "types", "components", "contracts"],
  "must_not_import": ["app", "adapters"]
}
```

## Public Surface

- **Exports (via ../public.ts):** none (internal to feature)
- **Files considered API:** provider-icons.ts (internal only)

## Responsibilities

- **This directory does:** Provide static configuration data (icon mappings, provider metadata)
- **This directory does not:** Implement UI components, manage state, or make API calls

## Usage

```typescript
// Used internally by ModelPicker component
import { resolveModelIcon } from "../config/provider-icons";

// Tries providerKey first, falls back to model ID prefix matching
const Icon = resolveModelIcon(model.ref.providerKey, model.ref.modelId);
```

## Standards

- Pure data/config only (no side effects)
- Use only bundled assets (Lucide icons + custom SVG icon components)
- Icon resolution: direct providerKey lookup → model ID prefix mapping → Zap fallback
- Internal to feature (not exported via public.ts)

## Dependencies

- **Internal:** none
- **External:** lucide-react

## Change Protocol

- No public API changes (internal directory)
- Add new provider mappings as models expand
- Keep icons limited to Lucide (no external icon deps)

## Notes

- Icons matched by providerKey or model ID prefix (e.g., "gpt-4o-mini" → "openai" → OpenAIIcon)
- MODEL_PREFIX_TO_PROVIDER maps: gpt/o1/o3/o4/chatgpt→openai, claude→anthropic, gemini→google
- Direct PROVIDER_ICONS keys: amazon, anthropic, deepseek, google, kimi, minimax, mistral, nvidia, llama, openai, qwen, xai
- Fallback to Zap icon for unknown providers
