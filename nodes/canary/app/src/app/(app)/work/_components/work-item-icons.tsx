// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import {
  Ban,
  BookOpen,
  Bug,
  CheckCircle,
  CheckSquare,
  CircleDashed,
  ClipboardCheck,
  Code,
  CornerDownRight,
  FlaskConical,
  GitMerge,
  Pencil,
  Search,
  XCircle,
} from "lucide-react";
import type { ReactElement } from "react";

// --- Type icons ---

const TYPE_ICON_MAP: Record<
  string,
  { icon: typeof Bug; colorClass: string; label: string }
> = {
  task: { icon: CheckSquare, colorClass: "text-info", label: "Task" },
  bug: { icon: Bug, colorClass: "text-danger", label: "Bug" },
  story: { icon: BookOpen, colorClass: "text-primary", label: "Story" },
  spike: { icon: FlaskConical, colorClass: "text-warning", label: "Spike" },
  subtask: {
    icon: CornerDownRight,
    colorClass: "text-muted-foreground",
    label: "Subtask",
  },
};

export function TypeIcon({
  type,
  className,
}: {
  readonly type: string;
  readonly className?: string;
}): ReactElement {
  const entry = TYPE_ICON_MAP[type];
  if (!entry) return <span className={cn("text-xs", className)}>{type}</span>;
  const Icon = entry.icon;
  return (
    <Icon
      className={cn("size-4", entry.colorClass, className)}
      aria-label={entry.label}
    />
  );
}

// --- Status icons ---

const STATUS_ICON_MAP: Record<
  string,
  { icon: typeof Bug; colorClass: string; label: string }
> = {
  needs_triage: {
    icon: CircleDashed,
    colorClass: "text-muted-foreground",
    label: "Needs triage",
  },
  needs_research: {
    icon: Search,
    colorClass: "text-warning",
    label: "Needs research",
  },
  needs_design: {
    icon: Pencil,
    colorClass: "text-warning",
    label: "Needs design",
  },
  needs_implement: {
    icon: Code,
    colorClass: "text-info",
    label: "Needs implement",
  },
  needs_closeout: {
    icon: ClipboardCheck,
    colorClass: "text-info",
    label: "Needs closeout",
  },
  needs_merge: {
    icon: GitMerge,
    colorClass: "text-success",
    label: "Needs merge",
  },
  done: { icon: CheckCircle, colorClass: "text-success", label: "Done" },
  blocked: { icon: Ban, colorClass: "text-danger", label: "Blocked" },
  cancelled: {
    icon: XCircle,
    colorClass: "text-muted-foreground",
    label: "Cancelled",
  },
};

export function StatusIcon({
  status,
  className,
}: {
  readonly status: string;
  readonly className?: string;
}): ReactElement {
  const entry = STATUS_ICON_MAP[status];
  if (!entry) return <span className={cn("text-xs", className)}>{status}</span>;
  const Icon = entry.icon;
  return (
    <Icon
      className={cn("size-4", entry.colorClass, className)}
      aria-label={entry.label}
    />
  );
}

/** Status text with tinted background pill. */
export function StatusPill({
  status,
  className,
}: {
  readonly status: string;
  readonly className?: string;
}): ReactElement {
  const entry = STATUS_ICON_MAP[status];
  const Icon = entry?.icon;
  const colorClass = entry?.colorClass ?? "text-muted-foreground";
  const label = status.replace("needs_", "").replaceAll("_", " ");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium text-xs capitalize",
        colorClass,
        className
      )}
    >
      {Icon && <Icon className="size-3.5" />}
      {label}
    </span>
  );
}
