// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/deployments/NodeDeployments`
 * Purpose: Owner-facing "Deployments" section under the node page — the SEE flow surface PLUS the
 *   owner-driven per-env Deploy / Undeploy control (story.5020 W4). Shows, per env, whether THIS node is
 *   live (serving) and at what buildSha, and a Deploy/Undeploy action to add/remove the node from that
 *   env's reach. ATOMIC_PER_ENV: every env (Test / Preview / Production) is an independent toggle —
 *   candidate-a is no different. Mirrors the `<NodeAccess>` section shape.
 * Scope: Server-rendered layout (SectionCard + Table primitives) from a pre-fetched per-env deploy
 *   state list; the action cell is a small client island ({@link NodeEnvToggle}) that POSTs the env verb.
 * Side-effects: none (the client action cell owns the POST)
 * Links: src/adapters/server/deploy/probe-deploy.adapter.ts (NodeDeployState source),
 *   src/features/nodes/deployments/NodeEnvToggle.client.tsx (action cell),
 *   src/app/api/v1/nodes/[id]/envs/route.ts, src/features/nodes/access/NodeAccess.tsx (mirrored shape),
 *   docs/design/operator-managed-deployments.md § SEE
 * @public
 */

import type { NodeDeployState } from "@cogni/ai-tools";
import { CheckCircle, Circle } from "lucide-react";
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

import { NodeEnvToggle } from "./NodeEnvToggle.client";

// Label each env by its user-facing TIER (its role), not the backend deploy-lane id: candidate-a → Test.
// The VM PLACEMENT (which slot serves a tier) is deliberately NOT surfaced yet — with one test VM it adds
// no signal and would only show on one row. It earns a sub-label once a tier fans out across VMs
// (candidate-a, candidate-b, … for PR-validation volume); until then the tier name is the whole story.
const ENV_TIER: Record<string, string> = {
  "candidate-a": "Test",
  preview: "Preview",
  production: "Production",
};

function tierLabel(env: string): string {
  return ENV_TIER[env] ?? env;
}

/** A live env serves /readyz 200; the probe adapter maps that to health=healthy. */
function isLive(state: NodeDeployState): boolean {
  return state.health === "healthy";
}

interface Props {
  readonly nodeId: string;
  readonly envs: ReadonlyArray<NodeDeployState>;
}

function DeployRow({
  nodeId,
  state,
}: {
  readonly nodeId: string;
  readonly state: NodeDeployState;
}): ReactElement {
  const live = isLive(state);
  return (
    <TableRow>
      <TableCell className="font-medium text-foreground text-sm">
        {tierLabel(state.env)}
      </TableCell>
      <TableCell className="text-sm">
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <CheckCircle className="size-4 text-success" aria-hidden="true" />
            Live
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Circle className="size-4" aria-hidden="true" />
            Not deployed
          </span>
        )}
      </TableCell>
      <TableCell className="text-right font-mono text-muted-foreground text-xs">
        {state.buildSha ? state.buildSha.slice(0, 7) : "—"}
      </TableCell>
      <TableCell className="text-right">
        <NodeEnvToggle nodeId={nodeId} env={state.env} inReach={live} />
      </TableCell>
    </TableRow>
  );
}

export function NodeDeployments({ nodeId, envs }: Props): ReactElement {
  return (
    <SectionCard title="Deployments" className="mx-auto mt-4 w-full max-w-2xl">
      <p className="text-muted-foreground text-sm">
        Where this node is live across the deploy environments, read directly
        from each env's public surface. Deploy or undeploy this node in any env
        — each toggle opens a one-file operator pull request; the change lands
        once that PR merges. Every environment is independent.
      </p>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Build</TableHead>
              <TableHead className="text-right">Reach</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {envs.map((state) => (
              <DeployRow key={state.env} nodeId={nodeId} state={state} />
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
