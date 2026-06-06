// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/components/GraphPicker`
 * Purpose: Provides graph/agent selection dialog for chat interface.
 * Scope: Feature-specific controlled UI component for selecting AI graphs. Does not manage state, persistence, or catalog data (delegates to parent).
 * Invariants: Responsive CSS (mobile bottom-sheet, desktop centered modal).
 * Side-effects: none (controlled component, delegates state to parent)
 * Notes: Uses Dialog+ScrollArea from shadcn. Simpler than ModelPicker (no search, fewer options).
 * Links: Used by ChatComposerExtras
 * @internal
 */

"use client";

import type { GraphId } from "@cogni/ai-core";
import { cn } from "@cogni/node-ui-kit/util/cn";
import { Bot, Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/kit/overlays/Dialog";

/**
 * Graph descriptor for UI display.
 * Matches AgentDescriptor from port layer.
 * Per LANGGRAPH_SERVER_ALIGNED: uses 'name' field.
 */
export interface GraphOption {
  /** Fully-qualified graph ID (e.g., "langgraph:poet") */
  readonly graphId: GraphId;
  /** Human-readable name (matches LangGraph Server 'name' field) */
  readonly name: string;
  /** Short description (nullable per LangGraph Server) */
  readonly description: string | null;
}

export interface GraphPickerProps {
  graphs: readonly GraphOption[];
  value: GraphId;
  onValueChange: (graphId: GraphId) => void;
  disabled?: boolean;
}

export function GraphPicker({
  graphs,
  value,
  onValueChange,
  disabled,
}: Readonly<GraphPickerProps>) {
  const [open, setOpen] = useState(false);

  const selectedGraph = graphs.find((g) => g.graphId === value);
  const displayName = selectedGraph?.name || "Select agent";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            // Base styles - rounded-full like model picker
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5",
            "h-[var(--size-composer-icon-btn)] w-auto",
            "border-none bg-transparent shadow-none outline-none",
            // Typography
            "font-semibold text-muted-foreground text-xs",
            // Hover
            "transition-colors hover:bg-accent hover:text-foreground",
            // Active/expanded state
            "aria-[expanded=true]:bg-accent aria-[expanded=true]:text-foreground",
            // Disabled state
            "disabled:pointer-events-none disabled:opacity-50"
          )}
          aria-label="Select agent"
        >
          <Bot className="size-3.5 shrink-0" />
          <span className="max-w-[var(--max-width-model-trigger)] truncate">
            {displayName}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
      </DialogTrigger>

      <DialogContent
        className={cn(
          // Mobile: centered card with margins
          "fixed inset-3 top-auto w-auto max-w-none translate-x-0 translate-y-0 rounded-2xl",
          "max-h-[var(--max-height-dialog-mobile)]",
          // Desktop: centered modal
          "sm:inset-auto sm:top-[var(--center-50)] sm:left-[var(--center-50)] sm:w-full",
          "sm:translate-x-[var(--center-neg-50)] sm:translate-y-[var(--center-neg-50)]",
          "sm:max-h-[var(--max-height-dialog)] sm:max-w-md sm:rounded-2xl",
          // Shared — override base grid with flex
          "flex flex-col gap-4"
        )}
      >
        <DialogHeader>
          <DialogTitle>Select Agent</DialogTitle>
        </DialogHeader>

        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
          <div className="space-y-1">
            {graphs.map((graph) => {
              const isSelected = graph.graphId === value;

              return (
                <button
                  key={graph.graphId}
                  type="button"
                  onClick={() => {
                    onValueChange(graph.graphId);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left",
                    "transition-colors hover:bg-accent",
                    isSelected && "bg-accent"
                  )}
                >
                  <Bot className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-sm">
                      {graph.name}
                    </div>
                    {graph.description && (
                      <div className="truncate text-muted-foreground text-xs">
                        {graph.description}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <Check className="size-4 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
