// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/components/ChatErrorBubble`
 * Purpose: Minimal inline error message styled as a chat bubble with red outline.
 * Scope: Feature-specific component for chat errors. Does not implement error handling or business logic.
 * Invariants: Uses semantic tokens only; matches user message bubble styling with destructive color variant.
 * Side-effects: none
 * Notes: Styled to match user message bubbles (rounded-3xl) with red outline and minimal background.
 * Links: Used in chat page; styled like user messages in vendor thread
 * @public
 */

"use client";

import { AlertCircle } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/kit/inputs/Button";

export interface ChatErrorBubbleProps {
  /** Human-readable error message */
  message: string;
  /** Show retry button */
  showRetry?: boolean;
  /** Show "Use Free Model" button */
  showSwitchFree?: boolean;
  /** Show "Add Credits" button */
  showAddCredits?: boolean;
  /** Callback when retry clicked */
  onRetry?: () => void;
  /** Callback when "Use Free Model" clicked */
  onSwitchFreeModel?: () => void;
  /** Callback when "Add Credits" clicked */
  onAddCredits?: () => void;
}

/**
 * Minimal error message bubble for inline chat errors.
 * Styled like a user message bubble with red outline and alert icon.
 */
export const ChatErrorBubble: FC<ChatErrorBubbleProps> = ({
  message,
  showRetry,
  showSwitchFree,
  showAddCredits,
  onRetry,
  onSwitchFreeModel,
  onAddCredits,
}) => {
  return (
    <div className="wrap-break-word mx-2 rounded-3xl border border-destructive bg-destructive/5 px-5 py-2.5">
      <div className="flex items-center gap-3">
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 text-destructive text-sm">
          {message}
        </span>
        {showRetry && onRetry && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRetry}
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Retry
          </Button>
        )}
        {showSwitchFree && onSwitchFreeModel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSwitchFreeModel}
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Use Free Model
          </Button>
        )}
        {showAddCredits && onAddCredits && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddCredits}
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Add Credits
          </Button>
        )}
      </div>
    </div>
  );
};
