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

import { ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button } from "@/components";
import type { NodeStatus } from "@/shared/db/nodes";

import { LaunchPackCopyButton } from "./LaunchPackCopyButton.client";

interface Props {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly publishedHandoff?: {
    readonly nodeRepoUrl: string | null;
    readonly knowledgeRepoUrl: string | null;
    readonly publishPrUrl: string | null;
  };
}

interface NodeActionErrorBody {
  readonly error?: unknown;
  readonly reason?: unknown;
  readonly errorCode?: unknown;
  readonly step?: unknown;
  readonly reqId?: unknown;
}

function formatActionError(body: NodeActionErrorBody, status: number): string {
  const reason = typeof body.reason === "string" ? body.reason : null;
  const error = typeof body.error === "string" ? body.error : null;
  const errorCode =
    typeof body.errorCode === "string" ? `errorCode=${body.errorCode}` : null;
  const step = typeof body.step === "string" ? `step=${body.step}` : null;
  const reqId = typeof body.reqId === "string" ? `reqId=${body.reqId}` : null;
  const fields = [errorCode, step, reqId].filter(Boolean).join(" ");
  const prefix = reason ?? error ?? `HTTP ${status}`;
  return fields ? `${prefix} (${fields})` : prefix;
}

export function NodeActionPanel({
  nodeId,
  status,
  publishedHandoff,
}: Props): ReactElement {
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
        setError(formatActionError(body, res.status));
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
          {submitting ? "Creating repo…" : "Create node repo PR"}
        </Button>
      );
      break;
    case "published":
      action = (
        <div className="space-y-5 text-sm">
          <div className="space-y-2">
            <p className="font-medium text-base text-foreground">
              Launch pack ready.
            </p>
            <p className="text-muted-foreground">
              Copy the prompt, then open the new node repo and DoltHub repo.
            </p>
          </div>

          <LaunchPackCopyButton nodeId={nodeId} />

          <div className="grid gap-2 sm:grid-cols-3">
            {publishedHandoff?.nodeRepoUrl ? (
              <Button asChild size="xl" variant="outline" className="w-full">
                <a
                  href={publishedHandoff.nodeRepoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Node repo
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            ) : null}
            {publishedHandoff?.knowledgeRepoUrl ? (
              <Button asChild size="xl" variant="outline" className="w-full">
                <a
                  href={publishedHandoff.knowledgeRepoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  DoltHub repo
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            ) : null}
            {publishedHandoff?.publishPrUrl ? (
              <Button asChild size="xl" variant="outline" className="w-full">
                <a
                  href={publishedHandoff.publishPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Deployment PR
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      );
      break;
    case "wallet_ready":
      action = (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Operator wallet is ready. Activate payment rails next.
          </p>
          <div className="flex items-center gap-2">
            <Button disabled>Activate payments</Button>
            <LaunchPackCopyButton nodeId={nodeId} />
          </div>
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
