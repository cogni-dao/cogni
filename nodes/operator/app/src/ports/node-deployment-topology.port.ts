// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-deployment-topology`
 * Purpose: Read the display-safe service topology in one environment's Git-declared deployment.
 * Scope: Names and public/private visibility only; no images, ports, resources, secrets, or provider state.
 * Invariants: DEPLOYED_GIT_IS_AUTHORITY, DISPLAY_SAFE_ONLY, PROVIDER_NEUTRAL_OUTPUT.
 * Side-effects: Implementations may perform read-only VCS IO.
 * Links: docs/spec/ci-cd.md, task.5112
 * @public
 */

export interface NodeDeployedService {
  readonly name: string;
  readonly visibility: "public" | "private";
}

export interface NodeDeploymentTopologyPort {
  listServices(input: {
    readonly slug: string;
    readonly environment: "candidate-a" | "preview" | "production";
  }): Promise<readonly NodeDeployedService[]>;
}
