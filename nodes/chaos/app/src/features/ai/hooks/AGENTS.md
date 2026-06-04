# features/ai/hooks · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable
- **Parent:** [features/ai](../AGENTS.md)

## Purpose

React hooks for AI feature including models list fetching with React Query integration.

## Pointers

- [Parent: AI Feature](../AGENTS.md)
- **Related:** [/api/v1/ai/models](../../../app/api/v1/ai/models/) (endpoint), [../../contracts/](../../../contracts/) (ai.models.v1.contract)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["core", "ports", "shared", "types", "components", "contracts"],
  "must_not_import": ["app", "adapters"]
}
```

## Public Surface

- **Exports (via ../public.ts):** useModels
- **Routes:** none (consumes /api/v1/ai/models)
- **Files considered API:** useModels.ts

## Responsibilities

- **This directory does:** Provide React hooks wrapping API endpoints with React Query for caching and loading states
- **This directory does not:** Implement API endpoints, manage server-side cache, or handle authentication

## Usage

```typescript
import { useModels } from "@/features/ai/public";

function MyComponent() {
  const modelsQuery = useModels();

  if (modelsQuery.isLoading) return <div>Loading...</div>;
  if (modelsQuery.isError) return <div>Error loading models</div>;

  const { models, defaultModelId } = modelsQuery.data;
  // Use models...
}
```

## Standards

- Use React Query for all API data fetching
- Validate responses with contract schemas (Zod)
- Export through parent public.ts only
- Configure appropriate stale times (5min for models)
- Let errors propagate to caller (no silent failures)

## Dependencies

- **Internal:** @/contracts/ai.models.v1.contract
- **External:** @tanstack/react-query

## Change Protocol

- Update parent public.ts when adding/removing hook exports
- Update parent AGENTS.md when public surface changes
- Hook API changes require consumer updates
- Contract changes handled via Zod validation errors

## Notes

- useModels: 5min stale time, refetches on window focus
- Returns ModelsOutput from contract (models array + defaultModelId)
- Client-side validation with contract schema prevents shape drift
