// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/[id]/NodeActionPanel.client`
 * Purpose: Client island that renders the next-step action button for a node, keyed by status.
 * Scope: One button per status. The wallet-provision + publish actions POST to the operator's API and
 *   `router.refresh()` after success so the server-rendered dashboard re-fetches the row.
 * Links: task.5083
 * @public
 */

"use client";

import Link from "next/link";
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
        <Link href={`/setup/dao?nodeId=${nodeId}`}>
          <Button>Form DAO via wallet</Button>
        </Link>
      );
      break;
    case "dao_formed":
      action = (
        <Button
          disabled={submitting}
          onClick={() => postAction(`/api/v1/nodes/${nodeId}/provision-wallet`)}
        >
          {submitting
            ? "Provisioning…"
            : "Provision operator wallet (we'll do it)"}
        </Button>
      );
      break;
    case "wallet_ready":
      action = (
        <Link href={`/setup/dao/payments?nodeId=${nodeId}`}>
          <Button>Activate payments via wallet</Button>
        </Link>
      );
      break;
    case "payments_ready":
      action = (
        <Button
          disabled={submitting}
          onClick={() => postAction(`/api/v1/nodes/${nodeId}/publish`)}
        >
          {submitting ? "Opening PR…" : "Open repo-spec PR on target repo"}
        </Button>
      );
      break;
    case "active":
      action = (
        <p className="text-muted-foreground text-sm">
          Bootstrap complete. Merge the repo-spec PR in your target repo to
          finish.
        </p>
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
