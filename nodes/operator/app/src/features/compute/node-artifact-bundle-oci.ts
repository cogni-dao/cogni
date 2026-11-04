// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/node-artifact-bundle-oci`
 * Purpose: Preserve the existing import path for the shared pure OCI bundle contract.
 * Scope: Re-exports package validators and constants; does not perform registry IO or duplicate validation.
 * Invariants: The shared package owns bundle validation.
 * Side-effects: none
 * Links: packages/repo-spec/src/artifact-bundle-oci.ts, bug.5568
 * @internal
 */
export {
  buildNodeBundleTagRef,
  NODE_BUNDLE_ARTIFACT_TYPE,
  NODE_BUNDLE_PAYLOAD_FILE,
  NODE_BUNDLE_PAYLOAD_MEDIA_TYPE,
  verifyNodeBundleManifest,
} from "@cogni/repo-spec";
