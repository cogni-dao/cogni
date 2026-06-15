// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/access/AccessActions.client`
 * Purpose: Owner action buttons for one access row — Approve/Deny on a pending request, Revoke on
 *   an approved developer. Each click is an owner-gated decision against the existing
 *   POST /api/v1/nodes/[id]/developers route; the OpenFGA role tuple write is the authority.
 * Scope: Client island only. Shares busy/error state across a row's buttons, then refreshes the
 *   server-rendered list so the row moves between sections.
 * Side-effects: IO (POST decision), router.refresh.
 * Links: src/app/api/v1/nodes/[id]/developers/route.ts, ./NodeAccess.tsx
 * @public
 */

"use client";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: Decision): void => {
    setBusy(true);
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
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "request failed");
      } finally {
        // Always clear busy — never leave the button spinning if the refresh
        // is slow or the row persists (the role-blind/clobber cases).
        setBusy(false);
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
