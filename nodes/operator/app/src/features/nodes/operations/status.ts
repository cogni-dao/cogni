// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure, conservative rollup from observed deployment evidence to a user-facing node status. */

import type { NodeDeployState } from "@cogni/ai-tools";
import type { NodeStatus } from "@/shared/db/nodes";

export type NodeOperationsStatus =
  | "healthy"
  | "deploying"
  | "needs_attention"
  | "not_deployed"
  | "setting_up";

export function deriveNodeOperationsStatus(
  formationStatus: NodeStatus,
  environments: readonly (NodeDeployState & { readonly declared: boolean })[]
): NodeOperationsStatus {
  if (formationStatus === "failed") return "needs_attention";
  if (formationStatus !== "active") return "setting_up";

  const production = environments.find((item) => item.env === "production");
  if (!production?.declared) return "not_deployed";
  if (
    production.health === "healthy" &&
    production.sourceSha !== null &&
    production.sourceSha === production.buildSha
  ) {
    return "healthy";
  }
  if (
    environments.some(
      (item) =>
        (item.declared && item.health === "provisioning") ||
        (item.declared &&
          item.replicas.desired > 0 &&
          item.replicas.ready < item.replicas.desired)
    )
  ) {
    return "deploying";
  }
  return "needs_attention";
}
