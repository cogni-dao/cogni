// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/operator`
 * Purpose: Expose the raw OpenFGA adapter to Cogni's trusted operator control plane.
 * Scope: Operator-only entrypoint. Independently governed nodes must use the mediated remote adapter.
 * Invariants: Raw OpenFGA reachability never crosses the operator trust boundary.
 * Side-effects: none
 * Links: docs/spec/rbac.md, task.5226
 * @public
 */

export {
  OpenFgaAuthorizationAdapter,
  type OpenFgaAuthorizationAdapterConfig,
  type OpenFgaCheckClient,
  type OpenFgaCheckOptions,
  type OpenFgaCheckRequest,
  type OpenFgaStoreClient,
  type OpenFgaWriteClient,
} from "./adapters/openfga-authorization.adapter";
