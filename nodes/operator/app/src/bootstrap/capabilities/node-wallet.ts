// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-wallet`
 * Purpose: Thin factory that the wizard API route calls to provision a Privy operator wallet.
 * Scope: Reads env, returns the operator-wallet provisioner adapter; route never imports the adapter
 *   directly (architecture: only bootstrap may import adapters).
 * Side-effects: none (adapter call deferred to caller)
 * Links: src/adapters/server/privy/operator-wallet-provisioner.ts, task.5083
 * @internal
 */

import {
  type ProvisionedOperatorWallet,
  provisionOperatorWallet,
} from "@/adapters/server/privy/operator-wallet-provisioner";
import type { ServerEnv } from "@/shared/env";

export type { ProvisionedOperatorWallet };

export async function provisionNodeWallet(
  env: ServerEnv
): Promise<ProvisionedOperatorWallet> {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    throw new Error(
      "operator not configured for wallet provisioning: PRIVY_APP_ID and PRIVY_APP_SECRET must be set"
    );
  }
  return provisionOperatorWallet({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
  });
}
