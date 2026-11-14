// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-ui-kit/tool-card`
 * Purpose: Visual primitive for tool-call rendering in the assistant chat — icon + 1-liner title (chip/link params allowed) + collapsible details body. Shared across all node apps.
 * Scope: Presentational. Does not import from `@assistant-ui/react`, does not own runtime state, does not fetch data — stays usable from default fallback and per-tool renderers in any node.
 * Invariants: ZERO_ASSISTANT_UI_COUPLING — no `@assistant-ui/react` imports here.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/custom-tool-call-renderer
 * @public
 */

"use client";

import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "../util/cn";

export type ToolCardTone =
  | "default"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const TONE_ICON_CLASS: Record<ToolCardTone, string> = {
  default: "text-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-muted-foreground",
};

export interface ToolCardProps {
  readonly icon: LucideIcon;
  readonly iconClassName?: string | undefined;
  readonly tone?: ToolCardTone | undefined;
  readonly title: ReactNode;
  readonly details?: ReactNode | undefined;
  readonly defaultOpen?: boolean | undefined;
}

export function ToolCard({
  icon: Icon,
  iconClassName,
  tone = "default",
  title,
  details,
  defaultOpen = false,
}: ToolCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();
  const canExpand = details != null;

  return (
    <div className="aui-tool-card my-2 w-full overflow-hidden rounded-md border border-border/60 bg-muted/20 text-sm">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          canExpand ? "cursor-pointer hover:bg-muted/40" : "cursor-default"
        )}
        onClick={canExpand ? () => setOpen((o) => !o) : undefined}
        aria-expanded={canExpand ? open : undefined}
        aria-controls={canExpand ? detailsId : undefined}
        disabled={!canExpand}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            TONE_ICON_CLASS[tone],
            iconClassName
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-foreground">{title}</div>
        {canExpand && (
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
            aria-hidden
          />
        )}
      </button>
      {canExpand && open && (
        <div
          id={detailsId}
          className="border-border/60 border-t bg-background/40 px-3 py-2"
        >
          {details}
        </div>
      )}
    </div>
  );
}
