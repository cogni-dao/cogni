// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-wallet-provisioner`
 * Purpose: Thin factory the node-wallet route calls to get a Privy wallet creator for the wizard's
 *   "Create node wallet" step (story.0083).
 * Scope: Reads PRIVY_APP_ID + PRIVY_APP_SECRET only. Returns undefined when either is unset so the
 *   route can fail closed (503). Never touches PRIVY_SIGNING_KEY: this path creates wallets, it signs
 *   nothing.
 * Side-effects: none (the Privy client is built; IO happens on the caller's first call)
 * Links: packages/operator-wallet/src/adapters/privy/privy-node-wallet-provisioner.adapter.ts
 * @internal
 */

import {
  createPrivyNodeWalletProvisioner,
  type NodeWalletProvisioner,
} from "@cogni/operator-wallet/adapters/privy";
import type { ServerEnv } from "@/shared/env";

export function createNodeWalletProvisioner(
  env: Pick<ServerEnv, "PRIVY_APP_ID" | "PRIVY_APP_SECRET">
): NodeWalletProvisioner | undefined {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) return undefined;
  return createPrivyNodeWalletProvisioner({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
  });
}
