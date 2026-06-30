// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/NodeDecommissionDangerZone.client`
 * Purpose: Owner-only destructive control to fully decommission a node — drop it from candidate-a
 *   (Test), preview AND production in one operator-authored catalog PR. The UI surface for the
 *   story.5020 W4 verb's full-decommission shape: `POST /api/v1/nodes/[id]/envs`
 *   `{ env: "candidate-a", present: false, decommission: true }` (candidate-a is otherwise mandatory
 *   — CANDIDATE_A_ALWAYS — so this is the ONLY path that drops it).
 * Scope: Renders a compact "Decommission node" danger-zone SectionCard (page-aligned with the
 *   Reset-DAO Danger zone). Mirrors `ResetDaoDangerZone` — a two-step reveal: one destructive button,
 *   then a type-the-slug confirmation guard + final confirm/cancel. POSTs the verb and surfaces the
 *   resulting PR link; the change lands once that PR merges.
 * Side-effects: IO (POST envs route, router.refresh)
 * Links: src/app/api/v1/nodes/[id]/envs/route.ts, src/features/nodes/ResetDaoDangerZone.client.tsx,
 *   src/app/(app)/nodes/[id]/page.tsx, story.5020
 * @public
 */

"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button, Input, SectionCard } from "@/components";

interface Props {
  readonly nodeId: string;
  readonly slug: string;
}

export function NodeDecommissionDangerZone({
  nodeId,
  slug,
}: Props): ReactElement {
  const router = useRouter();
  const expected = `decommission ${slug}`;
  const [revealed, setRevealed] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const matches = confirm === expected;

  const cancel = () => {
    setRevealed(false);
    setConfirm("");
    setError(null);
  };

  const handleDecommission = async () => {
    if (!matches || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setPrUrl(null);
    try {
      const response = await fetch(`/api/v1/nodes/${nodeId}/envs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env: "candidate-a",
          present: false,
          decommission: true,
        }),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON falls through to the raw-text error path
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
      const result =
        parsed && typeof parsed === "object" && "result" in parsed
          ? (parsed as { result: { status?: string; prUrl?: string } }).result
          : null;
      if (result?.status === "pr_opened" && result.prUrl) {
        setPrUrl(result.prUrl);
      }
      setRevealed(false);
      setConfirm("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "decommission failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SectionCard
      title="Decommission node"
      className="mx-auto mt-4 w-full max-w-2xl"
    >
      <p className="text-muted-foreground text-sm">
        Removes <span className="font-medium">{slug}</span> from candidate-a
        (Test), preview, AND production — the node leaves the deploy catalog
        entirely. Opens a one-file operator pull request; the node stops being
        deployed once it merges. Reversible by re-adding the envs.
      </p>

      {prUrl ? (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
        >
          Decommission PR opened — node leaves all envs once it merges
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}

      {revealed ? (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Type <code className="font-mono">{expected}</code> to confirm.
          </p>
          <Input
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder={expected}
            aria-label="Decommission confirmation"
            spellCheck={false}
            autoComplete="off"
          />
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={handleDecommission}
              disabled={!matches || submitting}
              className="gap-2"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Confirm decommission
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="destructive"
          onClick={() => setRevealed(true)}
        >
          Decommission node
        </Button>
      )}
    </SectionCard>
  );
}
