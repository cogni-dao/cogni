// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/access/AccessActions.client`
 * Purpose: Owner action buttons for one access row — Approve/Deny on a pending request, Revoke on
 *   an approved developer. Each click is an owner-gated decision against the existing
 *   POST /api/v1/nodes/[id]/developers route; the OpenFGA role tuple write is the authority.
 * Scope: Client island only. The clicked button shows a kit waiting signal (Loader2) and the loading
 *   state spans BOTH the POST and the server re-render (useTransition wraps router.refresh), so the
 *   click visibly completes — the row moves between sections — or surfaces an error, but never hangs.
 * Side-effects: IO (POST decision), router.refresh (inside a transition).
 * Links: src/app/api/v1/nodes/[id]/developers/route.ts, ./NodeAccess.tsx
 * @public
 */

"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useEffect, useState, useTransition } from "react";

import { Button } from "@/components";
import type { NodeAccessRole } from "@/shared/db/node-access-requests";

type Decision = "approve" | "reject";
type Variant = "default" | "outline" | "destructive";

interface ActionSpec {
  readonly decision: Decision;
  readonly label: string;
  readonly variant: Variant;
}

interface Props {
  readonly nodeId: string;
  readonly agentUserId: string;
  // The role the decision acts on — approve grants it, revoke/deny removes it.
  // Omitting it makes the route default to `developer` (the role-blind bug).
  readonly role: NodeAccessRole;
  readonly actions: ReadonlyArray<ActionSpec>;
}

export function AccessActions({
  nodeId,
  agentUserId,
  role,
  actions,
}: Props): ReactElement {
  const router = useRouter();
  // `submitting` tracks the in-flight POST (and which button fired it); `isRefreshing` tracks the
  // subsequent RSC re-render. The loading signal spans both — the previous code cleared a single
  // `busy` flag the instant the POST resolved, BEFORE the fire-and-forget router.refresh() re-rendered,
  // so the button re-enabled while the row still showed the old state — which read as a hang until a
  // second click forced the refresh to land.
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [isRefreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const busy = submitting !== null || isRefreshing;

  // When a post-success refresh settles, drop the spinner even if the row happened to persist —
  // a re-enabled button always beats an indefinite spin.
  useEffect(() => {
    if (!isRefreshing) {
      setSubmitting(null);
    }
  }, [isRefreshing]);

  const decide = (decision: Decision): void => {
    setSubmitting(decision);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/v1/nodes/${nodeId}/developers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentUserId, decision, role }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            errorCode?: string;
            error?: string;
          };
          setError(body.errorCode ?? body.error ?? `HTTP ${res.status}`);
          setSubmitting(null);
          return;
        }
        // Keep the waiting signal through the server re-render so the click visibly completes
        // (the row moves between sections) instead of appearing to hang.
        startTransition(() => {
          router.refresh();
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "request failed");
        setSubmitting(null);
      }
    })();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {actions.map((action) => (
          <Button
            key={action.decision + action.label}
            size="sm"
            variant={action.variant}
            disabled={busy}
            rightIcon={
              submitting === action.decision ? (
                <Loader2 className="animate-spin" />
              ) : undefined
            }
            onClick={() => decide(action.decision)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </div>
  );
}
