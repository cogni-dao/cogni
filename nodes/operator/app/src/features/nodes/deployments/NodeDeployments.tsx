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
import type { ReactElement } from "react";

import { SectionCard } from "@/components";

import {
  DeploymentEnvironmentMatrix,
  type DeploymentEnvironmentRow,
} from "./DeploymentEnvironmentMatrix";
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

export function NodeDeployments({ nodeId, envs }: Props): ReactElement {
  const rows: DeploymentEnvironmentRow[] = envs.map((state) => {
    const live = isLive(state);
    return {
      env: state.env,
      label: tierLabel(state.env),
      declared: live,
      health: state.health,
      sourceSha: state.sourceSha,
      buildSha: state.buildSha,
      action: <NodeEnvToggle nodeId={nodeId} env={state.env} inReach={live} />,
    };
  });

  return (
    <SectionCard title="Deployments" className="mx-auto mt-4 w-full max-w-2xl">
      <p className="text-muted-foreground text-sm">
        Where this node is live across the deploy environments, read directly
        from each env's public surface. Deploy or undeploy this node in any env
        — each toggle opens a one-file operator pull request; the change lands
        once that PR merges. Every environment is independent.
      </p>

      <DeploymentEnvironmentMatrix rows={rows} />
    </SectionCard>
  );
}
