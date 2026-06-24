// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/access/AccessActions.client`
 * Purpose: Owner action buttons for one access row — Approve/Deny on a pending request, Revoke on
 *   an approved developer. Each click is an owner-gated decision against the existing
 *   POST /api/v1/nodes/[id]/developers route; the OpenFGA role tuple write is the authority.
 * Scope: Client island only. The clicked button shows a kit waiting signal (Loader2) tied strictly to
 *   the in-flight decision POST — always cleared when it settles, so the button completes or errors but
 *   never hangs. On success router.refresh() (inside a transition, to avoid the clobber race) moves the
 *   row between sections; the spinner is NOT gated on the transition's pending flag, which can stick.
 * Side-effects: IO (POST decision), router.refresh (inside a transition, fire-and-forget).
 * Links: src/app/api/v1/nodes/[id]/developers/route.ts, ./NodeAccess.tsx
 * @public
 */

"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState, useTransition } from "react";

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
  // `submitting` tracks the in-flight decision POST (and which button fired it) — and ONLY that. It
  // is the single source of the waiting signal and is always cleared when the request settles, so the
  // button can never spin forever. We deliberately do NOT gate the UI on useTransition's pending flag:
  // `router.refresh()` wrapped in a transition can leave that flag stuck indefinitely, which both
  // froze the spinner AND blocked the re-render (the infinite-spinner bug).
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
          return;
        }
        // The decision committed server-side (the role tuple + best-effort row transition). Reconcile
        // the server-rendered list so the row moves between sections. Wrapped in a transition so this
        // non-urgent RSC refetch isn't clobbered by the urgent setSubmitting(null) below — the race
        // that originally made the click need a second press — but the spinner is NOT tied to it.
        startTransition(() => {
          router.refresh();
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "request failed");
      } finally {
        // Always clear the waiting signal once the request resolves — success or failure — so the
        // button completes or errors, but never hangs.
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
            disabled={submitting !== null}
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
