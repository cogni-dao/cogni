// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/deployments/NodeEnvToggle.client`
 * Purpose: Per-row Deploy / Undeploy control for the node Deployments table — the UI surface for the
 *   story.5020 W4 env-membership verb `POST /api/v1/nodes/[id]/envs`. ATOMIC_PER_ENV: every env is an
 *   independent toggle (Test / Preview / Production alike — candidate-a is no different). If this node's
 *   reach includes the env, the control undeploys it (`present:false`); otherwise it deploys it
 *   (`present:true`). On success it surfaces the opened PR link (lands after the PR merges).
 *   A deployed env also carries the PLACEMENT lever (story.5016 T5): a k3s/Akash select that POSTs
 *   `{env, placement}` — the same verb, mutually exclusive with `present` — picking which lane
 *   (k3s overlay/AppSet vs the external ComputeWorkload reconciler) serves the env.
 * Scope: A single client cell the server Deployments table renders per row. POSTs the env verb, shows
 *   pending state, and surfaces the PR link / no_changes / error inline. Reuses the app UI primitives.
 * Side-effects: IO (POST envs route, router.refresh)
 * Links: src/app/api/v1/nodes/[id]/envs/route.ts, src/features/nodes/deployments/NodeDeployments.tsx,
 *   story.5020
 * @public
 */

"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";

type ToggleResult =
  | { kind: "pr_opened"; action: string; prUrl: string }
  | { kind: "no_changes"; verb: "reach" | "placement" }
  | null;

interface Props {
  readonly nodeId: string;
  /** The env (deploy-lane id, e.g. `candidate-a`) this row controls. */
  readonly env: string;
  /** True when this node's reach currently includes `env` (→ an Undeploy control). */
  readonly inReach: boolean;
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

export function NodeEnvToggle({ nodeId, env, inReach }: Props): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ToggleResult>(null);

  const submit = async (
    payload:
      | { readonly present: boolean }
      | { readonly placement: "k3s" | "akash" }
  ) => {
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
        body: JSON.stringify({ env, ...payload }),
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
          action: envResult.action ?? (inReach ? "remove" : "add"),
          prUrl: envResult.prUrl,
        });
      } else {
        setResult({
          kind: "no_changes",
          verb: "placement" in payload ? "placement" : "reach",
        });
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "env update failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Placement lever (story.5016 T5) — only meaningful for an env already in reach. The
            catalog is the placement SSOT and is not pre-fetched here; the verb is idempotent, so a
            re-selected current lane surfaces as "no change". */}
        {inReach ? (
          <Select
            onValueChange={(value) =>
              submit({ placement: value as "k3s" | "akash" })
            }
            disabled={submitting}
          >
            <SelectTrigger className="h-8 w-28 text-xs" aria-label="Placement">
              <SelectValue placeholder="Placement" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="k3s">k3s</SelectItem>
              <SelectItem value="akash">Akash</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <Button
          type="button"
          variant={inReach ? "outline" : "default"}
          size="sm"
          onClick={() => submit({ present: !inReach })}
          disabled={submitting}
          className="gap-2"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {inReach ? "Undeploy" : "Deploy"}
        </Button>
      </div>

      {result?.kind === "pr_opened" ? (
        <a
          href={result.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-primary text-xs hover:underline"
        >
          PR opened — lands after it merges
          <ExternalLink className="size-3" />
        </a>
      ) : null}
      {result?.kind === "no_changes" ? (
        <span className="text-muted-foreground text-xs">
          {/* no_changes means the env already held the ATTEMPTED state. */}
          {result.verb === "placement"
            ? "Already on that placement."
            : `Already ${inReach ? "not deployed" : "deployed"}.`}
        </span>
      ) : null}
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </div>
  );
}
