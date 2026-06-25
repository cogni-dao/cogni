// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/access/AccessActions.client`
 * Purpose: Owner action buttons for one access row — Approve/Deny on a pending request, Revoke on
 *   an approved developer. Each click is an owner-gated decision against the existing
 *   POST /api/v1/nodes/[id]/developers route; the OpenFGA role tuple write is the authority.
 * Scope: Client island only. The clicked button shows a kit waiting signal (Loader2). On success it
 *   calls router.refresh() and KEEPS spinning — the server re-render moves the row out of its section
 *   and unmounts the button, which ends the spinner. Clearing client state in the same tick as
 *   router.refresh() clobbers the RSC re-render (the "needs a second click / hangs" bug), so we clear
 *   `submitting` only on error. Mirrors the wizard steps' POST → router.refresh() pattern.
 * Side-effects: IO (POST decision), router.refresh.
 * Links: src/app/api/v1/nodes/[id]/developers/route.ts, ./NodeAccess.tsx
 * @public
 */

"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

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
  // `submitting` holds the in-flight decision (and which button fired it) — the single source of the
  // waiting signal.
  const [submitting, setSubmitting] = useState<Decision | null>(null);
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
          setSubmitting(null); // re-enable so the owner can retry/correct
          return;
        }
        // Success: the decision is committed server-side. Refresh the server-rendered list so this
        // row leaves its section (approve → Approved, deny/revoke → gone). Deliberately do NOT clear
        // `submitting` here: clearing client state in the same tick as router.refresh() clobbers the
        // RSC re-render — the bug that made the click need a second press / look hung. The spinner
        // keeps showing until the refresh re-renders and this row unmounts, matching the wizard steps'
        // POST → router.refresh() pattern (RepoStep/DaoStep).
        router.refresh();
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
            disabled={submitting !== null}
            onClick={() => decide(action.decision)}
          >
            {/* Swap the label FOR the spinner (don't append it) so the button never grows wider
                while loading — appending widened the Actions cell and overflowed the table. */}
            {submitting === action.decision ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              action.label
            )}
          </Button>
        ))}
      </div>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </div>
  );
}
