# governance · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Governance feature slice — schedule sync, governance status dashboard, claimant-aware epoch contribution UI (current epoch, history, holdings), approver review page with subject-level override editing and EIP-712 signing, and on-chain signal execution (CogniAction event → GitHub actions via governance).

## Pointers

- [Governance Scheduling Spec](../../../../../docs/spec/governance-scheduling.md)
- [Attribution Ledger Spec](../../../../../docs/spec/attribution-ledger.md)
- [Repo Spec Config](../../../../../.cogni/repo-spec.yaml)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["features", "ports", "core", "shared", "types"],
  "must_not_import": [
    "app",
    "adapters/server",
    "adapters/worker",
    "bootstrap",
    "contracts"
  ]
}
```

## Public Surface

- **Exports (services):** `syncGovernanceSchedules()`, `GovernanceScheduleSyncDeps`, `GovernanceScheduleSyncResult`, `governanceScheduleId()`, `getGovernanceStatus()`, `GovernanceStatusResult`, `dispatchSignalExecution()`, `handleSignal()`, `SignalHandlerDeps`
- **Exports (hooks):** `useGovernanceStatus()`, `useCurrentEpoch()`, `useEpochHistory()`, `useHoldings()`, `useReviewEpochs()`, `useSignEpoch()`, `useReviewSubjectOverrides()`
- **Exports (components):** `ContributorCard`, `ContributionRow`, `EpochCard`, `EpochCountdown`, `EpochDetail`, `HoldingCard`, `SourceBadge`
- **Exports (lib):** `composeEpochView()`, `composeEpochViewFromClaimants()`, `applyOverridesToEpochView()`, `composeHoldings()`
- **Exports (types):** `EpochView`, `EpochContributor`, `IngestionReceipt`, `HoldingView`, `CurrentEpochData`, `EpochHistoryData`, `HoldingsData`, `SignEpochState`, `SignEpochPhase`, `ReviewSubjectOverrideView`, `EpochDetailProps`, `Signal`, `ActionResult`, `RepoRef`
- **Exports (signal):** `parseCogniAction()`, `parseRepoRef()`, `COGNI_TOPIC0`, `resolveAction()`, `mergeChange()`, `grantCollaborator()`, `revokeCollaborator()`
- **Routes (app pages):** `/gov` (system), `/gov/epoch` (current), `/gov/history` (finalized), `/gov/holdings` (aggregated), `/gov/review` (approver admin — inline editing + EIP-712 sign & finalize)
- **Routes (API — in `src/app/api/v1/attribution/`):** `GET /epochs`, `GET /epochs/:id/user-projections`, `GET /epochs/:id/statement`, `GET /epochs/:id/claimants`, `GET /epochs/:id/activity`, `GET /epochs/:id/sign-data`, `GET|PATCH|DELETE /epochs/:id/review-subject-overrides`
- **CLI:** `pnpm governance:schedules:sync`, `pnpm db:seed`, `pnpm dev:setup`
- **Env/Config keys:** `.cogni/repo-spec.yaml` → `governance.schedules`, `cogni_dao` (signal contract, chain_id, etc.)

## Ports

- **Uses ports:** `ScheduleControlPort` (Temporal lifecycle), `ExecutionGrantUserPort.ensureGrant` (stable grant), `AccountService` (balance), `GovernanceStatusPort` (schedule/run queries)
- **Implements ports:** none

## Responsibilities

- This directory **does**: Sync governance schedules; provide epoch UI hooks, view-model composition, and presentational components; pause removed schedules (PRUNE_IS_PAUSE); decode and execute on-chain CogniAction signals (merge PR, grant/revoke collaborator)
- This directory **does not**: Execute workflows, manage tenant-facing schedule CRUD, access DB directly, perform credit math (ALL_MATH_BIGINT stays server-side), verify webhooks (that's the adapter's job)

## Usage

```bash
pnpm test tests/unit/features/governance/  # unit tests
pnpm governance:schedules:sync             # trigger internal route (app must be running)
pnpm dev:setup                             # db:setup + db:setup:test + gov schedule sync
```

## Standards

- Hooks fetch attribution activity and claimant endpoints, compose via `lib/` pure functions into view models (`types.ts`)
- Components are presentational only — no data fetching
- No direct adapter or DB imports

## Dependencies

- **Internal:** `@cogni/scheduler-core` (ports), `@/shared/config` (governance config, DAO config), `@tanstack/react-query` (hooks), `p-limit` (concurrent fetches)
- **External:** `lucide-react` (icons), `viem` (ABI decoding, RPC client), `@octokit/core` + `@octokit/auth-app` (GitHub API)

## Change Protocol

- Update this file when exports, routes, or env/config changes
- Bump **Last reviewed** date
- Ensure `pnpm check` passes

## Notes

- Governance schedules are system-ops only; never exposed as tenant-facing API
- PRUNE_IS_PAUSE: removed charters get paused, never deleted
- Epoch seed script uses `computeEpochWindowV1()` from `@cogni/attribution-ledger` for Monday-aligned UTC windows matching the scheduler grid
- Display names and linked/unlinked presentation are resolved server-side from claimant reads; UI never renders raw `userId` fragments
