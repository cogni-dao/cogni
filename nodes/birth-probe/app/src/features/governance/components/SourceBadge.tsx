// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/SourceBadge`
 * Purpose: Badge showing contribution source (GitHub or Discord) with color-coded styling.
 * Scope: Governance feature component. Uses project Badge with inline color overrides. Does not handle data fetching.
 * Invariants: GitHub uses primary purple; Discord uses accent teal.
 * Side-effects: none
 * Links: src/components/kit/data-display/Badge.tsx
 * @public
 */

"use client";

import { GitBranch, MessageSquare } from "lucide-react";
import type { ReactElement } from "react";

import { Badge } from "@/components";

type Source = "github" | "discord";

export function SourceBadge({ source }: { source: Source }): ReactElement {
  const isGithub = source === "github";
  return (
    <Badge
      intent="outline"
      size="sm"
      className={`gap-1 text-xs ${
        isGithub
          ? "border-primary/40 text-primary"
          : "border-accent/40 text-accent"
      }`}
    >
      {isGithub ? (
        <GitBranch className="h-3 w-3" />
      ) : (
        <MessageSquare className="h-3 w-3" />
      )}
      {isGithub ? "GitHub" : "Discord"}
    </Badge>
  );
}
