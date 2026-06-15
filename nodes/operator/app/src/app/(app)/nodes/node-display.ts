// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/node-display`
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
    description: "Create the node repo and open the operator deployment PR.",
  },
  published: {
    label: "Repo PR opened",
    intent: "default",
    description:
      "Node repo is pinned for deployment. Hand the launch pack to your AI agent next.",
  },
  wallet_ready: {
    label: "Wallet ready",
    intent: "secondary",
    description: "Operator wallet is ready. Configure payments next.",
  },
  payments_ready: {
    label: "Payments ready",
    intent: "secondary",
    description: "Payments configured. Open the activation PR to go live.",
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
