// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-ui-kit/tool-fallback`
 * Purpose: Default tool-call renderer for assistant-ui chat — used when no per-tool UI is registered. Wraps the shared ToolCard with a humanized name + arg summary in the 1-liner and pretty-printed args/result in the collapsible body. Status-driven icon/tone covers running / cancelled / error / complete.
 * Scope: Couples to `@assistant-ui/react` types via peer dep. Pure presentation otherwise — does not own runtime state, does not register any per-tool UI, does not fetch data.
 * Invariants: STATUS_DRIVES_ICON — icon/tone come from `MessagePartStatus`, not `result`.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/custom-tool-call-renderer
 * @public
 */

"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  AlertTriangleIcon,
  CircleSlashIcon,
  CogIcon,
  Loader2Icon,
} from "lucide-react";
import { ToolCard, type ToolCardTone } from "../tool-card";
import { cn } from "../util/cn";

const NAMESPACE_PREFIX = "core__";
const MAX_ARG_ENTRIES = 3;
const MAX_ARG_VALUE_CHARS = 40;

function humanizeToolName(toolName: string): string {
  const stripped = toolName.startsWith(NAMESPACE_PREFIX)
    ? toolName.slice(NAMESPACE_PREFIX.length)
    : toolName;
  return stripped.replace(/_/g, " ");
}

function summarizeArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return null;

  const formatted = entries.slice(0, MAX_ARG_ENTRIES).map(([k, v]) => {
    const value =
      typeof v === "string"
        ? v
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : JSON.stringify(v);
    const truncated =
      value.length > MAX_ARG_VALUE_CHARS
        ? `${value.slice(0, MAX_ARG_VALUE_CHARS)}…`
        : value;
    return `${k}=${truncated}`;
  });

  const overflow = entries.length - MAX_ARG_ENTRIES;
  return overflow > 0
    ? `${formatted.join(", ")}, +${overflow} more`
    : formatted.join(", ");
}

export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
}) => {
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const hasError =
    status?.type === "incomplete" && status.reason !== "cancelled";
  const isRunning =
    status?.type === "running" || status?.type === "requires-action";

  const Icon = isCancelled
    ? CircleSlashIcon
    : hasError
      ? AlertTriangleIcon
      : isRunning
        ? Loader2Icon
        : CogIcon;
  const tone: ToolCardTone = isCancelled
    ? "muted"
    : hasError
      ? "danger"
      : isRunning
        ? "info"
        : "default";
  const iconClassName = isRunning ? "animate-spin" : undefined;

  const cancelledReason =
    isCancelled && status.error
      ? typeof status.error === "string"
        ? status.error
        : JSON.stringify(status.error)
      : null;

  const summary = summarizeArgs(args);
  const title = (
    <span
      className={cn(
        "inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5",
        isCancelled && "line-through opacity-70"
      )}
    >
      <span className="font-medium">{humanizeToolName(toolName)}</span>
      {summary && (
        <span className="truncate font-mono text-muted-foreground text-xs">
          {summary}
        </span>
      )}
    </span>
  );

  const details = (
    <div className="flex flex-col gap-2 text-xs">
      {cancelledReason && (
        <div>
          <div className="mb-1 font-semibold text-muted-foreground">
            Cancelled
          </div>
          <pre className="whitespace-pre-wrap break-all font-mono text-muted-foreground">
            {cancelledReason}
          </pre>
        </div>
      )}
      <div>
        <div className="mb-1 font-semibold text-muted-foreground">
          Arguments
        </div>
        <pre className="whitespace-pre-wrap break-all font-mono text-foreground/80">
          {argsText || "(none)"}
        </pre>
      </div>
      {!isCancelled && result !== undefined && (
        <div className="border-border/60 border-t border-dashed pt-2">
          <div className="mb-1 font-semibold text-muted-foreground">Result</div>
          <pre className="whitespace-pre-wrap break-all font-mono text-foreground/80">
            {typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );

  return (
    <ToolCard
      icon={Icon}
      iconClassName={iconClassName}
      tone={tone}
      title={title}
      details={details}
      defaultOpen={hasError}
    />
  );
};
