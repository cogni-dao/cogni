// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/chat/ComposerVoiceInput`
 * Purpose: Provides voice-to-text dictation toggle button for the chat composer.
 * Scope: Single toggle button using assistant-ui state to switch between start/stop dictation.
 *   Does not implement speech recognition logic (delegates to assistant-ui runtime + DictationAdapter).
 * Invariants: PROGRESSIVE_ENHANCEMENT — renders nothing when no DictationAdapter is configured.
 * Side-effects: none (pure layout composition)
 * Notes: Single Mic icon. Uses useAui/useAuiState to read dictation state and call start/stop.
 * Links: @assistant-ui/react useAui, useAuiState
 * @public
 */

"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { MicIcon } from "lucide-react";
import { useCallback } from "react";

import { TooltipIconButton } from "@/components/vendor/assistant-ui/tooltip-icon-button";

/**
 * Voice-to-text dictation toggle for the chat composer.
 *
 * Single mic button: click to start dictation, click again to stop.
 * Renders nothing when no DictationAdapter is configured (progressive enhancement).
 */
export function ComposerVoiceInput() {
  const aui = useAui();
  const hasDictation = useAuiState((s) => s.thread.capabilities.dictation);
  const isDictating = useAuiState((s) => s.composer.dictation != null);

  const handleClick = useCallback(() => {
    if (isDictating) {
      aui.composer().stopDictation();
    } else {
      aui.composer().startDictation();
    }
  }, [aui, isDictating]);

  if (!hasDictation) return null;

  return (
    <TooltipIconButton
      tooltip={isDictating ? "Stop dictation" : "Dictate"}
      side="bottom"
      type="button"
      size="icon"
      className={`aui-composer-dictation size-(--size-composer-icon-btn) rounded-full border-none bg-transparent p-1 shadow-none transition-colors hover:bg-accent dark:hover:bg-accent ${
        isDictating
          ? "text-primary hover:text-primary"
          : "text-muted-foreground hover:text-foreground"
      }`}
      aria-label={isDictating ? "Stop dictation" : "Dictate"}
      onClick={handleClick}
    >
      <MicIcon className="aui-composer-dictation-icon size-5" />
    </TooltipIconButton>
  );
}
