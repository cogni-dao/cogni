// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/operator-change-recovery.server`
 * Purpose: Thin app seam for one durable operator-change recovery attempt.
 * Scope: Delegates a strict request to VcsCapability and validates the semantic result.
 * Invariants: Fresh GitHub state and every write remain inside the VCS capability boundary.
 * Side-effects: GitHub reads/writes through VcsCapability.
 * Links: task.5188
 * @internal
 */

import type { VcsCapability } from "@cogni/ai-tools";
import {
  type OperatorChangeRecoveryRequest,
  type OperatorChangeRecoveryResult,
  OperatorChangeRecoveryResultSchema,
} from "@cogni/node-contracts";

export async function recoverOperatorChange(
  input: OperatorChangeRecoveryRequest,
  vcs: VcsCapability
): Promise<OperatorChangeRecoveryResult> {
  return OperatorChangeRecoveryResultSchema.parse(
    await vcs.recoverOperatorChange(input)
  );
}
