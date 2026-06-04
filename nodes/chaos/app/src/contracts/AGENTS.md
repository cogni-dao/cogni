# contracts · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-03-05
- **Status:** draft

## Purpose

Single source of truth for externally callable operations. Each file defines an operation contract: stable id, Zod input/output, scopes, and versioning. No business logic.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)
- **Related:** [shared/schemas](../shared/) (reusable primitives), [types](../types/) (compile-time only)

## Boundaries

```json
{
  "layer": "contracts",
  "may_import": ["shared", "types"],
  "must_not_import": [
    "app",
    "features",
    "adapters/server",
    "adapters/worker",
    "core",
    "ports"
  ]
}
```

## Public Surface

- **Exports:** chat.completions.v1 (graph_name optional), ai.chat.v1 (AssistantUiInputSchema, ChatInput, ChatOutput, ChatMessage), ai.agents.v1 (AgentDescriptor, AgentsOutput), ai.models.v1, error.chat.v1, payments.intent.v1, payments.submit.v1, payments.status.v1, payments.credits.confirm.v1, payments.credits.summary.v1, analytics.summary.v1, meta.livez.read.v1, meta.readyz.read.v1, meta.route-manifest.read.v1, schedules.create.v1, schedules.list.v1, schedules.update.v1, schedules.delete.v1, governance.schedules.sync.internal.v1, ai.activity.v1 (ActivityGroupBySchema, ActivityGroupBy), ledger.list-epochs.v1, ledger.epoch-activity.v1, ledger.epoch-user-projections.v1, ledger.epoch-claimants.v1, ledger.epoch-statement.v1, ledger.patch-review-subject-overrides.v1, ledger.get-review-subject-overrides.v1, ledger.delete-review-subject-override.v1, ledger.record-pool-component.v1, ledger.finalize-epoch.v1, users.profile.read.v1, users.profile.update.v1, users.ownership.read.v1, work.items.list.v1 (WorkItemDtoSchema, WorkItemDto, WorkItemsListInput, WorkItemsListOutput), work.items.get.v1 (WorkItemsGetInput, WorkItemsGetOutput); http/router.v1.ts (ts-rest contracts); http/openapi.v1.ts (OpenAPI generation)
- **Files considered API:** \*.contract.ts, http/router.v1.ts, http/openapi.v1.ts

## Ports (optional)

- **Uses ports:** none
- **Implements ports:** none
- **Contracts:** n/a

## Responsibilities

- This directory **does**: define operation IO and policy; version contracts; enable generation later.
- This directory **does not**: contain domain rules, persistence, or transport code.

## Usage

```bash
pnpm -w lint
pnpm -w typecheck
```

## Implementation Guidelines

When implementing or updating an API endpoint:

1. **Define the contract first** in `src/contracts/<feature>.<name>.v1.contract.ts`
2. **In facades/routes/services**, derive types from the contract:

   ```typescript
   import type { z } from "zod";
   import { myOperation } from "@/contracts/my-feature.v1.contract";

   type Input = z.infer<typeof myOperation.input>;
   type Output = z.infer<typeof myOperation.output>;
   ```

3. **In tests**, import and use the contract schema for validation:
   ```typescript
   const result = await myOperation.output.parse(response);
   ```
4. **Never introduce a parallel TypeScript interface** for the same payload shape
5. **Contract changes flow one way:** Update contract → Fix TypeScript errors → Fix Zod validation errors

This prevents drift between routes, facades, services, tests, and UI clients. The contract owns the shape.

## Standards

- Zod schemas only; export Input/Output TS types via z.infer.
- Contract IDs are namespaced and versioned, e.g. `chat.completions.v1`, `admin.accounts.register.v1`.
- Breaking changes require new version suffix.

## Dependencies

- **Internal:** shared/schemas (primitives), types/
- **External:** zod, @ts-rest/core, @ts-rest/open-api

## Change Protocol

- On shape change: bump id version, update tests, mark **Reviewed in PR**.
- Keep old versions until callers migrate.

## Notes

- HTTP layer (http/) contains ts-rest router and OpenAPI generation from protocol-neutral contracts.
- Protocol-neutral contracts enable both HTTP (ts-rest) and MCP tool generation.
