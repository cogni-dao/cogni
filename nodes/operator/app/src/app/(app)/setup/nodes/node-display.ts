// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/node-display`
 * Purpose: Human-facing labels for each node-setup status — keeps the raw status enum
 *   (e.g. `dao_pending`) out of the UI in favor of plain copy + a Badge intent.
 * Scope: Presentation-only mapping shared by the list + detail pages.
 * Side-effects: none
 * Links: src/features/nodes/state-machine.ts, task.5083
 * @public
 */

import type { NodeStatus } from "@/shared/db/nodes";

type BadgeIntent = "default" | "secondary" | "destructive" | "outline";

interface StatusDisplay {
  readonly label: string;
  readonly intent: BadgeIntent;
  readonly description: string;
}

export const NODE_STATUS_DISPLAY: Record<NodeStatus, StatusDisplay> = {
  dao_pending: {
    label: "Forming DAO",
    intent: "secondary",
    description: "Form this node's DAO with your wallet to continue.",
  },
  dao_formed: {
    label: "DAO formed",
    intent: "secondary",
    description: "Publish the governance PR to register this node.",
  },
  published: {
    label: "Published",
    intent: "default",
    description: "Governance PR opened. Wallet provisioning is next.",
  },
  wallet_ready: {
    label: "Wallet ready",
    intent: "secondary",
    description: "Operator wallet is ready. Configure payments next.",
  },
  payments_ready: {
    label: "Payments ready",
    intent: "secondary",
    description: "Payments configured. Publish activation to go live.",
  },
  active: {
    label: "Active",
    intent: "default",
    description: "This node is live.",
  },
  failed: {
    label: "Failed",
    intent: "destructive",
    description: "Setup failed. Register the node again to retry.",
  },
};
