// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/deployments/NodeDeployments`
 * Purpose: Owner-facing "Deployments" section under the node page — the read-only SEE flow surface.
 *   Shows, per env, whether THIS node is live (serving) and at what buildSha, so a wizard-test junk
 *   node (live nowhere) is visibly distinct from a real one. Mirrors the `<NodeAccess>` section shape.
 * Scope: Server-rendered layout (SectionCard + Table primitives) from a pre-fetched per-env deploy
 *   state list. No client islands, no I/O — the page fetches the state via the DeployCapability.
 * Side-effects: none
 * Links: src/adapters/server/deploy/probe-deploy.adapter.ts (NodeDeployState source),
 *   src/features/nodes/access/NodeAccess.tsx (mirrored shape), docs/design/operator-managed-deployments.md § SEE
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
  readonly envs: ReadonlyArray<NodeDeployState>;
}

function DeployRow({
  state,
}: {
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
    </TableRow>
  );
}

export function NodeDeployments({ envs }: Props): ReactElement {
  return (
    <SectionCard title="Deployments" className="mx-auto mt-4 w-full max-w-2xl">
      <p className="text-muted-foreground text-sm">
        Where this node is live across the deploy environments, read directly
        from each env's public surface. A node live nowhere is still being set
        up (or junk); a real node serves at least one env.
      </p>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Build</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {envs.map((state) => (
              <DeployRow key={state.env} state={state} />
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
