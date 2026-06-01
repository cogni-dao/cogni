# bootstrap/ai · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** stable

## Purpose

AI tool bindings and tool source factory. Wires tool implementations with injected capabilities at bootstrap time.

## Pointers

- [Tool Use Spec](../../../../../docs/spec/tool-use.md)
- [Tools Authoring](../../../../../docs/guides/tools-authoring.md)

## Boundaries

```json
{
  "layer": "bootstrap",
  "may_import": ["bootstrap"],
  "must_not_import": ["app", "features", "core", "adapters"]
}
```

## Public Surface

- **Exports:** `createToolBindings()`, `createBoundToolSource()`, `ToolBindings`, `ToolBindingDeps`
- **Files considered API:** `tool-bindings.ts`, `tool-source.factory.ts`

## Responsibilities

- This directory **does**: Wire tool implementations with capabilities, create ToolSourcePort
- This directory **does not**: Execute tools, contain business logic

## Usage

```bash
# Consumed by container.ts automatically
```

## Standards

- Per CAPABILITY_INJECTION: implementations receive capabilities at construction

## Dependencies

- **Internal:** bootstrap
- **External:** `@cogni/ai-core`, `@cogni/ai-tools`

## Change Protocol

- Add new tools to `tool-bindings.ts` when adding to TOOL_CATALOG

## Notes

- Per TOOL_BINDING_REQUIRED: createBoundToolSource throws if any catalog tool lacks binding
