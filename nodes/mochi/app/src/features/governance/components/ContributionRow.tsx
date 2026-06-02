// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/ContributionRow`
 * Purpose: Single receipt sub-row within a contributor's expanded detail — aligned to parent table columns.
 * Scope: Governance feature component. Does not perform data fetching or server-side logic.
 * Invariants: Event types map to Lucide icons and display labels. Renders as a TableRow for column alignment.
 * Side-effects: none
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import type { LucideIcon } from "lucide-react";
import {
  ExternalLink,
  Eye,
  GitCommit,
  GitPullRequest,
  MessageCircle,
  MessageSquare,
  Pin,
  ThumbsUp,
} from "lucide-react";
import type { ReactElement } from "react";

import { TableCell, TableRow } from "@/components";
import type { IngestionReceipt } from "@/features/governance/types";

import { SourceBadge } from "./SourceBadge";

export const TYPE_ICONS: Record<string, LucideIcon> = {
  pr_merged: GitPullRequest,
  commit_pushed: GitCommit,
  review_submitted: Eye,
  comment_created: MessageCircle,
  message_sent: MessageSquare,
  reaction_added: ThumbsUp,
};

export const TYPE_LABELS: Record<string, string> = {
  pr_merged: "PR",
  commit_pushed: "Commit",
  review_submitted: "Review",
  comment_created: "Comment",
  message_sent: "Message",
  reaction_added: "Reaction",
};

export function receiptTitle(receipt: IngestionReceipt): string | null {
  const title = receipt.metadata?.title;
  return typeof title === "string" && title.length > 0 ? title : null;
}

export function ContributionRow({
  receipt,
}: {
  receipt: IngestionReceipt;
}): ReactElement {
  const Icon = TYPE_ICONS[receipt.eventType] ?? Pin;
  const title = receiptTitle(receipt);
  const score = receipt.units;
  const override = receipt.override;

  return (
    <TableRow className="hover:bg-muted/20">
      {/* Chevron column — empty for sub-rows */}
      <TableCell className="w-8 px-2" />
      {/* # column — type icon */}
      <TableCell className="w-10 text-center">
        <Icon className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
      </TableCell>
      {/* Contributor column — source badge + type label + title + link */}
      <TableCell>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <SourceBadge source={receipt.source as "github" | "discord"} />
          <span className="shrink-0 text-muted-foreground text-xs">
            {TYPE_LABELS[receipt.eventType] ?? receipt.eventType}
          </span>
          {title && (
            <>
              <span className="text-muted-foreground/40">·</span>
              {receipt.artifactUrl ? (
                <a
                  href={receipt.artifactUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex min-w-0 items-center gap-1 text-foreground/80 text-xs hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{title}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              ) : (
                <span className="truncate text-foreground/80 text-xs">
                  {title}
                </span>
              )}
            </>
          )}
          {!title && receipt.artifactUrl && (
            <a
              href={receipt.artifactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </TableCell>
      {/* Share column — empty for sub-rows */}
      <TableCell className="text-right" />
      {/* Score column */}
      <TableCell className="text-right">
        {override ? (
          <span
            className="font-mono text-warning text-xs"
            title={`Overridden from ${override.originalUnits} → ${override.overrideUnits}${override.reason ? `: ${override.reason}` : ""}`}
          >
            <span className="text-muted-foreground/50 line-through">
              {override.originalUnits}
            </span>
            {"  "}
            {override.overrideUnits}
          </span>
        ) : score != null ? (
          <span className="font-mono text-muted-foreground text-xs">
            {score}
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
