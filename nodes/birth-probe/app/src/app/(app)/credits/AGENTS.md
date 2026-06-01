# credits · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** draft

## Purpose

Protected credits page composition and payment widget wiring. Server component loads repo-spec-driven widget config; client component renders DePay widget and payment flows.

## Pointers

- [Root AGENTS.md](../../../AGENTS.md)
- [App AGENTS.md](../../AGENTS.md)
- [Repo-spec helper](../../../shared/config/repoSpec.server.ts)
- [Credits page client](./CreditsPage.client.tsx)

## Boundaries

```json
{
  "layer": "app",
  "may_import": [
    "app",
    "features",
    "ports",
    "shared",
    "contracts",
    "styles",
    "components"
  ],
  "must_not_import": ["adapters/server", "adapters/worker", "core"]
}
```

## Public Surface

- **Exports:** none
- **Route:** `/credits` (server page + client composition)
- **Files considered API:** `page.tsx`, `CreditsPage.client.tsx`

## Responsibilities

- **Does:** Fetch widget config server-side via `@/shared/config` (repo-spec), render credits UI, pass config to client DePay widget, trigger confirm calls.
- **Does not:** Read env vars or repo-spec on the client; hardcode wallets or chain IDs; bypass confirm endpoint/business logic.

## Usage

- Server page calls `getPaymentConfig()` and passes props to `CreditsPageClient`.
- Client component renders payment UI with provided chainId/receivingAddress and calls confirm endpoint on success.

## Standards

- Payment configuration must come from repo-spec via `getPaymentConfig()`; no env overrides or client-side file reads.

## Dependencies

- **Internal:** `@/shared/config`, `@/components/vendor/depay`, `@tanstack/react-query`
- **External:** none

## Change Protocol

- Update this file when route shape or config source changes.
- Keep widget config sourced from repo-spec; adjust boundaries if imports change.

## Notes

- Changing wallet/chain/provider requires editing `.cogni/repo-spec.yaml` and redeploying; no env overrides.
- Client code must treat widget configuration as props only.
