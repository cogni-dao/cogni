// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/DistributionsCard.client`
 * Purpose: Visible, owner-driven distribution-activation control — the UI surface for
 *   `POST /api/v1/nodes/[id]/activate-distributions`. Activation is NOT a hidden API: a node owner
 *   sees this card and clicks one button to open the metadata-only repo-spec PR that flips
 *   `distributions.status: active`.
 * Scope: Renders a compact "Distributions" SectionCard (page-aligned with NodeAccess/Danger zone).
 *   Non-destructive — single button, no typed confirmation. POSTs the existing activation route
 *   (owner-or-`node.flight` auth) and surfaces the resulting PR link (or "already active").
 * Side-effects: IO (POST activate-distributions route, router.refresh)
 * Links: src/app/api/v1/nodes/[id]/activate-distributions/route.ts, src/app/(app)/nodes/[id]/page.tsx
 * @public
 */

"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button, SectionCard } from "@/components";

interface Props {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoSpecUrl: string | null;
}

type Result =
  | { kind: "pr_opened"; prUrl: string }
  | { kind: "no_changes" }
  | null;

export function DistributionsCard({
  nodeId,
  slug,
  repoSpecUrl,
}: Props): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);

  const handleActivate = async () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(
        `/api/v1/nodes/${nodeId}/activate-distributions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON body falls through to the raw-text error path below
      }
      if (!response.ok) {
        let reason = `HTTP ${response.status}`;
        if (
          parsed &&
          typeof parsed === "object" &&
          "error" in parsed &&
          typeof (parsed as { error: unknown }).error === "string"
        ) {
          reason = (parsed as { error: string }).error;
        } else if (text.trim() !== "") {
          reason = text;
        }
        throw new Error(reason);
      }
      const activation =
        parsed && typeof parsed === "object" && "activation" in parsed
          ? (parsed as { activation: { status?: string; prUrl?: string } })
              .activation
          : null;
      if (activation?.status === "pr_opened" && activation.prUrl) {
        setResult({ kind: "pr_opened", prUrl: activation.prUrl });
      } else {
        setResult({ kind: "no_changes" });
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "activation failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SectionCard
      title="Distributions"
      className="mx-auto mt-4 w-full max-w-2xl"
    >
      <p className="text-muted-foreground text-sm">
        Records that <span className="font-medium">{slug}</span> is ready to pay
        contributors in its DAO token. Opens a one-file pull request on the
        node's repo writing <code>distributions.status: active</code> and the
        stock Uniswap MerkleDistributor claim pattern. Metadata only — the DAO
        is the minter, so no tokens move and nothing is pre-minted.
      </p>

      {result?.kind === "pr_opened" ? (
        <a
          href={result.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
        >
          Activation PR opened
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
      {result?.kind === "no_changes" ? (
        <p className="text-muted-foreground text-sm">
          Distributions already active — nothing to change.
        </p>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={handleActivate}
          disabled={submitting}
          className="gap-2"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          Activate distributions
        </Button>
        {repoSpecUrl ? (
          <a
            href={repoSpecUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground text-sm hover:text-foreground"
          >
            View repo-spec
          </a>
        ) : null}
      </div>
    </SectionCard>
  );
}
