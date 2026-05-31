# guards · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Pure validation guards for Brain-mode AI responses. Checks server-collected sources against response content to enforce NO_CLAIMS_WITHOUT_CITES.

## Pointers

- [COGNI_BRAIN_SPEC](../../../../../../docs/spec/cogni-brain.md)

## Boundaries

```json
{
  "layer": "shared",
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

- **Exports:** `needsCitationRetry()`, `parseCitation()`, `validateSources()`, `INSUFFICIENT_CITATION_MESSAGE`, `ParsedCitation`
- **Files considered API:** `citation.guard.ts`, `index.ts`

## Responsibilities

- This directory **does**: Validate citation tokens, detect repo mentions in responses, determine if retrieval retry is needed
- This directory **does not**: Perform IO, modify responses, execute tools, orchestrate retries

## Usage

```bash
pnpm test tests/unit/shared/ai/citation-guard.test.ts
```

## Standards

- All functions are pure — no side-effects, no network calls
- Brain-only: non-brain routes pass `requireCitations=false` (guard is inert)
- Sources are server-collected from tool outputs, not scraped from LLM text

## Dependencies

- **Internal:** none (pure validation)
- **External:** none

## Change Protocol

- Update this file when exports change
- Coordinate with COGNI_BRAIN_SPEC.md for invariant changes

## Notes

- Guard is a retrieval gate, not a content filter
- Citation format: `repo:<repoId>:<path>#L<start>-L<end>@<sha7>`
