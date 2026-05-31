// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/[id]/NodeActionPanel.client`
 * Purpose: Client island that renders the next-step action button for a node, keyed by status.
 * Scope: One button per status. The publish action POSTs to the operator's API and
 *   `router.refresh()` after success so the server-rendered dashboard re-fetches the row.
 * Links: task.5083
 * @public
 */

"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button } from "@/components";
import type { NodeStatus } from "@/shared/db/nodes";

interface Props {
  readonly nodeId: string;
  readonly status: NodeStatus;
}

export function NodeActionPanel({ nodeId, status }: Props): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postAction = async (path: string) => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(path, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.reason ?? body?.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSubmitting(false);
    }
  };

  let action: ReactElement;
  switch (status) {
    case "dao_pending":
      action = (
        <p className="text-muted-foreground text-sm">
          Use the DAO formation form on this page to continue.
        </p>
      );
      break;
    case "dao_formed":
      action = (
        <Button
          disabled={submitting}
          onClick={() => postAction(`/api/v1/nodes/${nodeId}/publish`)}
        >
          {submitting ? "Publishing…" : "Publish governance PR"}
        </Button>
      );
      break;
    case "published":
      action = (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Operator wallet provisioning is coming soon.
          </p>
          <Button disabled>Provision operator wallet</Button>
        </div>
      );
      break;
    case "wallet_ready":
      action = (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Operator wallet is ready. Activate payment rails next.
          </p>
          <Button disabled>Activate payments</Button>
        </div>
      );
      break;
    case "payments_ready":
      action = (
        <p className="text-muted-foreground text-sm">
          Payment activation is ready to publish. Opening the activation PR is
          the final step before this node becomes active.
        </p>
      );
      break;
    case "active":
      action = (
        <p className="text-muted-foreground text-sm">Node setup is active.</p>
      );
      break;
    case "failed":
      action = (
        <p className="text-destructive text-sm">
          Bootstrap failed. Re-register the node to start over.
        </p>
      );
      break;
  }

  return (
    <div className="space-y-2">
      {action}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </div>
  );
}
