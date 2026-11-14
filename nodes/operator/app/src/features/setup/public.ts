// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/setup/public`
 * Purpose: Public barrel exports for setup feature.
 * Scope: Re-exports hooks and types for external consumers. Does not contain implementation logic.
 * Invariants: Only exports public API; internal modules remain private.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

// Components
export { FormationFlowDialog } from "./components/FormationFlowDialog";

// Hooks
export {
  type DAOFormationConfig,
  type FormationState,
  type UseDAOFormationReturn,
  useDAOFormation,
  type VerifiedAddresses,
} from "./hooks/useDAOFormation";
