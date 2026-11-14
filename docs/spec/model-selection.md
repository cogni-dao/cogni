---
id: model-selection-spec
type: spec
title: Model Selection
status: active
spec_state: draft
trust: draft
summary: User-facing model selection via LiteLLM — dynamic metadata from litellm.config.yaml, server-side validation, 409 fallback, localStorage persistence.
read_when: Working with model picker UI, adding new models, debugging model validation failures, or modifying the LiteLLM config.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [ai-graphs]
---

# Model Selection

## Context

Users select their preferred AI model via a dropdown in the chat composer. The selection persists in localStorage and is validated server-side on every request. All model metadata is dynamically fetched from LiteLLM — no hardcoded model lists in application code.

## Goal

Provide dynamic, validated model selection where `litellm.config.yaml` is the single source of truth for available models, metadata flows automatically to the UI, and invalid selections fail gracefully with a 409 + auto-retry.

## Non-Goals

- Hardcoded model lists in application code (always dynamic from LiteLLM)
- Per-user model restrictions (all authenticated users see the same list)
- Model-specific pricing display (handled by billing layer, not model selection)

## Core Invariants

1. **LITELLM_CONFIG_IS_SOURCE_OF_TRUTH**: All model metadata comes from `infra/compose/configs/litellm.config.yaml`. No hardcoded model lists in application code.

2. **SERVER_SIDE_VALIDATION**: Server checks the requested model against a cached allowlist on every chat request. Invalid model returns 409 + `defaultModelId`.

3. **CLIENT_AUTO_RETRY**: On 409, client auto-retries once with the `defaultModelId` from the response. User sees seamless fallback.

4. **MODEL_FIELD_REQUIRED**: Chat requests require a `model` field (`selectedModel ?? defaultModelId`). No implicit default at the API boundary.

## Design

### Core Workflow

1. **Server**: Fetches models from LiteLLM `/model/info` endpoint (1h cache with SWR)
2. **Client**: Requests available models from `GET /api/v1/ai/models` (auth-required)
3. **UI**: Displays ModelPicker dialog with search, icons from `model_info.provider_key`, and free/paid badges from `model_info.is_free`
4. **Persistence**: Saves selection to localStorage (`cogni.chat.preferredModelId`), validates against API list on mount
5. **Request**: Chat sends `model` field (REQUIRED) as `selectedModel ?? defaultModelId`
6. **Validation**: Server checks model against cached allowlist (fast O(n) scan)
7. **Fallback**: Invalid model returns 409 + defaultModelId, client auto-retries once with default

### Data Flow

```
litellm.config.yaml (model_info)
  ↓ fetched every 1h
LiteLLM /model/info endpoint
  ↓ cached + SWR
GET /api/v1/ai/models (auth-protected)
  ↓ React Query (5min stale)
ModelPicker UI
  ↓ user selection
localStorage + Chat Request
  ↓ validated
Server (409 if invalid) → LiteLLM Adapter
```

### Single Source of Truth Mapping

| `litellm.config.yaml` field | App field     | Example                                                  |
| --------------------------- | ------------- | -------------------------------------------------------- |
| `model_name`                | `id`          | `"qwen3-4b"`, `"gpt-4o-mini"`                            |
| `model_info.display_name`   | `name`        | `"Qwen 3 4B (Free)"`                                     |
| `model_info.is_free`        | `isFree`      | boolean for tier badge                                   |
| `model_info.provider_key`   | `providerKey` | `"qwen"`, `"openai"`, `"anthropic"` (for icon rendering) |

### Endpoints

- `GET /api/v1/ai/models` → `{ models: Model[], defaultModelId: string }`
  - Model: `{ id, name?, isFree, providerKey? }`
- `POST /api/v1/ai/chat` → Accepts `model: string` (required), returns 409 if invalid

### Adding New Models

1. Update `litellm.config.yaml` with new model entry and `model_info` fields
2. Restart LiteLLM service
3. Cache refreshes within 1h (or immediately on first request after restart)
4. UI automatically shows new model

### File Pointers

| File                                                | Role                                                            |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `infra/compose/configs/litellm.config.yaml`         | Model definitions with model_info metadata (source of truth)    |
| `src/contracts/ai.models.v1.contract.ts`            | Models contract (id, name, isFree, providerKey, defaultModelId) |
| `src/app/_lib/models-cache.ts`                      | Fetches from LiteLLM /model/info, 1h cache with SWR             |
| `src/app/api/v1/ai/models/route.ts`                 | Auth-protected endpoint returning cached models                 |
| `src/contracts/ai.chat.v1.contract.ts:58`           | Chat contract with REQUIRED `model` field                       |
| `src/app/api/v1/ai/chat/route.ts:162-179`           | Validation with 409 retry response                              |
| `src/features/ai/public.ts`                         | Feature barrel (stable import surface)                          |
| `src/features/ai/components/ModelPicker.tsx`        | Dialog+ScrollArea picker with search                            |
| `src/features/ai/components/ChatComposerExtras.tsx` | Composer toolbar integration                                    |
| `src/features/ai/config/provider-icons.ts`          | Provider key → Lucide icon mapping                              |
| `src/components/kit/chat/Thread.tsx`                | Slot-based wrapper (`composerLeft` prop)                        |
| `src/app/(app)/chat/page.tsx:59-89`                 | State management                                                |

## Acceptance Checks

**Automated:**

- Contract test: `GET /api/v1/ai/models` returns valid `{ models, defaultModelId }` shape
- Validation test: `POST /api/v1/ai/chat` with invalid model returns 409 + `defaultModelId`

**Manual:**

1. Verify ModelPicker shows all models from `litellm.config.yaml` with correct icons and free/paid badges
2. Verify adding a new model to config → appears in UI after cache refresh
3. Verify selecting an invalid/stale model falls back gracefully (409 → auto-retry)

## Open Questions

_(none)_

## Related

- [AI Architecture and Evals](./ai-evals.md) — executor types and model routing
