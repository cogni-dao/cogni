// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/services/syncGovernanceSchedules`
 * Purpose: Re-export of syncGovernanceSchedules from @cogni/scheduler-core. Canonical implementation lives in the package.
 * Scope: Convenience re-export for feature-layer consumers. Does not contain any logic or wiring.
 * Invariants: No logic here — pure re-export.
 * Side-effects: none
 * Links: packages/scheduler-core/src/services/syncGovernanceSchedules.ts
 * @public
 */

export {
  type GovernanceScheduleConfig,
  type GovernanceScheduleEntry,
  type GovernanceScheduleSyncDeps,
  type GovernanceScheduleSyncResult,
  governanceScheduleId,
  syncGovernanceSchedules,
} from "@cogni/scheduler-core";
