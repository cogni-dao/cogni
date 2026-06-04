// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/chat/ComposerAddAttachment`
 * Purpose: Provides kit wrapper for attachment button with semantic token styling.
 * Scope: Re-exports vendor ComposerAddAttachment with accent hover styling override (matches card/model picker). Does not implement attachment functionality (delegates to vendor component).
 * Invariants: No behavior changes, only styling override.
 * Side-effects: none
 * Notes: Overrides vendor's raw muted-foreground/15 with semantic accent token.
 * Links: Wraps @/components/vendor/assistant-ui/attachment ComposerAddAttachment
 * @public
 */

"use client";

import { ComposerPrimitive } from "@assistant-ui/react";
import { PlusIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/vendor/assistant-ui/tooltip-icon-button";

export function ComposerAddAttachment() {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        size="icon"
        // eslint-disable-next-line ui-governance/no-arbitrary-non-token-values -- Matches vendor composer button size
        className="aui-composer-add-attachment size-[34px] rounded-full border-none bg-transparent p-1 text-muted-foreground shadow-none transition-colors hover:bg-accent hover:text-foreground dark:hover:bg-accent"
        aria-label="Add Attachment"
      >
        {/* eslint-disable-next-line ui-governance/no-arbitrary-non-token-values -- Matches vendor icon stroke */}
        <PlusIcon className="aui-attachment-add-icon size-5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
}
