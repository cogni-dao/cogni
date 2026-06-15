// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/access/NodeAccess`
 * Purpose: Owner-facing "Agents" section under the launch pack — replaces the DevTools-fetch hack
 *   with an in-UI request → approve / deny / revoke surface. Shows pending access requests and
 *   approved external agents for one node, each labeled with the capability its role confers.
 * Scope: Server-rendered layout (SectionCard + Table primitives, same shape as ActivityTable) from
 *   pre-fetched tracking rows + per-row client action islands. OpenFGA role tuples remain the
 *   authority; rows are tracking only.
 * Side-effects: none (AccessActions owns its IO)
 * Links: src/features/nodes/access-requests.ts, ./AccessActions.client.tsx, docs/spec/rbac.md §6
 * @public
 */

import type { ReactElement } from "react";

import {
  SectionCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import type { NodeAccessRequestRow } from "@/features/nodes/access-requests";
import type { NodeAccessRole } from "@/shared/db/node-access-requests";

import { AccessActions } from "./AccessActions.client";

// What each role lets an agent do, for display — one distinct, least-privilege
// role per capability (rbac.md §6). developer→can_flight, secrets_manager→
// can_manage_secrets, production_promoter→can_promote_production. Extends 1:1.
const ROLE_CAPABILITY: Record<NodeAccessRole, string> = {
  developer: "Candidate flight",
  secrets_manager: "Manage secrets",
  production_promoter: "Promote to production",
};

interface Props {
  readonly nodeId: string;
  readonly requests: ReadonlyArray<NodeAccessRequestRow>;
}

function agentLabel(row: NodeAccessRequestRow): string {
  return row.agentDisplayName?.trim() || `Agent ${row.agentUserId.slice(0, 8)}`;
}

function AccessRow({
  nodeId,
  row,
  mode,
}: {
  readonly nodeId: string;
  readonly row: NodeAccessRequestRow;
  readonly mode: "pending" | "approved";
}): ReactElement {
  return (
    <TableRow>
      <TableCell>
        <p className="font-medium text-foreground text-sm">{agentLabel(row)}</p>
        <p className="truncate font-mono text-muted-foreground text-xs">
          {row.agentUserId}
        </p>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {ROLE_CAPABILITY[row.role]}
      </TableCell>
      <TableCell className="text-right">
        {mode === "pending" ? (
          <AccessActions
            nodeId={nodeId}
            agentUserId={row.agentUserId}
            role={row.role}
            actions={[
              { decision: "approve", label: "Approve", variant: "default" },
              { decision: "reject", label: "Deny", variant: "outline" },
            ]}
          />
        ) : (
          <AccessActions
            nodeId={nodeId}
            agentUserId={row.agentUserId}
            role={row.role}
            actions={[
              { decision: "reject", label: "Revoke", variant: "destructive" },
            ]}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

function RequestGroup({
  title,
  nodeId,
  rows,
  mode,
}: {
  readonly title: string;
  readonly nodeId: string;
  readonly rows: ReadonlyArray<NodeAccessRequestRow>;
  readonly mode: "pending" | "approved";
}): ReactElement {
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {title}
      </h3>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <AccessRow key={row.id} nodeId={nodeId} row={row} mode={mode} />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function NodeAccess({ nodeId, requests }: Props): ReactElement {
  const pending = requests.filter((r) => r.status === "pending");
  const approved = requests.filter((r) => r.status === "approved");
  const isEmpty = pending.length === 0 && approved.length === 0;

  return (
    <SectionCard title="Agents" className="mx-auto mt-4 w-full max-w-2xl">
      <p className="text-muted-foreground text-sm">
        Approve external agents to act on this node. Each row shows the exact
        capabilities the agent's role grants.
      </p>

      {isEmpty ? (
        <p className="text-muted-foreground text-sm">No access requests yet.</p>
      ) : null}

      {pending.length > 0 ? (
        <RequestGroup
          title="Pending requests"
          nodeId={nodeId}
          rows={pending}
          mode="pending"
        />
      ) : null}

      {approved.length > 0 ? (
        <RequestGroup
          title="Approved agents"
          nodeId={nodeId}
          rows={approved}
          mode="approved"
        />
      ) : null}
    </SectionCard>
  );
}
