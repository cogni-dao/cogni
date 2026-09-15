// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/CopyForAiButton`
 * Purpose: A merge conflict on a knowledge contribution can only be fixed by its
 *   author — and authors are AI agents, not the human reviewing the inbox. So the
 *   human's job is to relay, not to "redo it from main." This button copies a
 *   paste-ready handoff (contribution id, branch, base, the conflict) that the
 *   reviewer drops back to the authoring agent to re-create on fresh main.
 * Scope: Pure presentation + clipboard write. Stops propagation so it can live in
 *   a clickable list row without triggering row navigation.
 * @internal
 */

"use client";

import type { ContributionRecord } from "@cogni/node-contracts";
import { Check, Copy } from "lucide-react";
import { type MouseEvent, useState } from "react";

function buildAiHandoff(item: ContributionRecord, reason: string): string {
  return [
    "Your knowledge contribution can't be merged into main — merge conflict.",
    "",
    `contribution: ${item.contributionId}`,
    `branch: ${item.branch}`,
    `base: ${item.baseCommit}`,
    `problem: ${reason}`,
    "",
    "Fix: start a new contribution from the current main, re-apply these entries, then resubmit. Don't reuse the stale branch.",
  ].join("\n");
}

export function CopyForAiButton({
  item,
  reason,
}: {
  readonly item: ContributionRecord;
  readonly reason: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(buildAiHandoff(item, reason));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable (insecure context / denied) — no-op
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title="Copy a fix message for your AI contributor"
      aria-label="Copy a fix message for your AI contributor"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-destructive/40 px-2 font-medium text-destructive text-xs transition-colors hover:bg-destructive/10"
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {copied ? "Copied" : "Copy for AI"}
    </button>
  );
}
