// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/NodeEnvMembership.client`
 * Purpose: Owner-driven env-membership controls — the UI surface for the story.5020 W4 verb
 *   `POST /api/v1/nodes/[id]/envs`. Lets an owner add/remove THIS node from preview / production
 *   (each toggle opens an operator-authored catalog PR), and shows candidate-a (Test) as an
 *   always-on / mandatory tier (CANDIDATE_A_ALWAYS) with no off-toggle. Full decommission lives
 *   in the sibling `NodeDecommissionDangerZone`.
 * Scope: Renders a compact "Environment reach" SectionCard (page-aligned with NodeDeployments /
 *   NodeAccess / Danger zone). Non-destructive per-env add/remove — single button per env, no typed
 *   confirmation. POSTs the env verb and surfaces the resulting PR link (or "already there").
 * Side-effects: IO (POST envs route, router.refresh)
 * Links: src/app/api/v1/nodes/[id]/envs/route.ts, src/features/nodes/deployments/NodeDeployments.tsx,
 *   src/app/(app)/nodes/[id]/page.tsx, story.5020
 * @public
 */

"use client";

import { ExternalLink, Loader2, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Badge, Button, SectionCard } from "@/components";

/** The two member-toggleable tiers and their user-facing labels (candidate-a is always-on, not here). */
const TOGGLEABLE_ENVS = [
  { env: "preview", tier: "Preview" },
  { env: "production", tier: "Production" },
] as const;

type ToggleableEnv = (typeof TOGGLEABLE_ENVS)[number]["env"];

type EnvResult =
  | { kind: "pr_opened"; action: string; prUrl: string }
  | { kind: "no_changes" }
  | null;

interface Props {
  readonly nodeId: string;
  readonly slug: string;
  /** Envs this node is currently in (derived from the page's live deploy state). */
  readonly memberEnvs: ReadonlyArray<string>;
}

async function parseError(response: Response): Promise<string> {
  const text = await response.text();
  let reason = `HTTP ${response.status}`;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      reason = (parsed as { error: string }).error;
    }
  } catch {
    if (text.trim() !== "") {
      reason = text;
    }
  }
  return reason;
}

function EnvRow({
  nodeId,
  env,
  tier,
  isMember,
}: {
  readonly nodeId: string;
  readonly env: ToggleableEnv;
  readonly tier: string;
  readonly isMember: boolean;
}): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnvResult>(null);

  const handleToggle = async () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/v1/nodes/${nodeId}/envs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env, present: !isMember }),
      });
      if (!response.ok) {
        throw new Error(await parseError(response));
      }
      const text = await response.text();
      const parsed: unknown = JSON.parse(text);
      const envResult =
        parsed && typeof parsed === "object" && "result" in parsed
          ? (
              parsed as {
                result: { status?: string; action?: string; prUrl?: string };
              }
            ).result
          : null;
      if (envResult?.status === "pr_opened" && envResult.prUrl) {
        setResult({
          kind: "pr_opened",
          action: envResult.action ?? (isMember ? "remove" : "add"),
          prUrl: envResult.prUrl,
        });
      } else {
        setResult({ kind: "no_changes" });
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "env update failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground text-sm">{tier}</span>
          {isMember ? (
            <Badge intent="secondary" size="sm">
              In reach
            </Badge>
          ) : (
            <Badge intent="outline" size="sm">
              Not added
            </Badge>
          )}
        </div>
        <Button
          type="button"
          variant={isMember ? "outline" : "default"}
          size="sm"
          onClick={handleToggle}
          disabled={submitting}
          className="gap-2"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {isMember ? `Remove from ${tier}` : `Add to ${tier}`}
        </Button>
      </div>

      {result?.kind === "pr_opened" ? (
        <a
          href={result.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
        >
          {result.action === "remove" ? "Remove" : "Add"} PR opened — changes
          land after it merges
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
      {result?.kind === "no_changes" ? (
        <p className="text-muted-foreground text-sm">
          Already {isMember ? "in" : "out of"} {tier} — nothing to change.
        </p>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </div>
  );
}

export function NodeEnvMembership({
  nodeId,
  slug,
  memberEnvs,
}: Props): ReactElement {
  const memberSet = new Set(memberEnvs);

  return (
    <SectionCard
      title="Environment reach"
      className="mx-auto mt-4 w-full max-w-2xl"
    >
      <p className="text-muted-foreground text-sm">
        Which deploy environments <span className="font-medium">{slug}</span> is
        configured to reach. Adding or removing an env opens a one-file operator
        pull request on the deploy catalog; the change lands once that PR
        merges.
      </p>

      <div className="divide-y rounded-md border px-4">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground text-sm">Test</span>
            <Badge intent="secondary" size="sm">
              Always on
            </Badge>
          </div>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
            <Lock className="size-3.5" aria-hidden="true" />
            Mandatory
          </span>
        </div>

        {TOGGLEABLE_ENVS.map(({ env, tier }) => (
          <EnvRow
            key={env}
            nodeId={nodeId}
            env={env}
            tier={tier}
            isMember={memberSet.has(env)}
          />
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        Test (candidate-a) is mandatory — every node validates there. To drop a
        node from Test you must decommission it entirely (see below).
      </p>
    </SectionCard>
  );
}
