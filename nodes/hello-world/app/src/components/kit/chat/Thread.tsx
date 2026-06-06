// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/chat/Thread`
 * Purpose: Provides kit wrapper for assistant-ui Thread with composition slots - stable API surface.
 * Scope: Dumb wrapper providing layout slots for app-specific features (model selection, etc.). Does not implement chat logic, state management, or business rules (delegates to vendor component and slot consumers).
 * Invariants: Vendor component remains quarantined, no feature/business logic in kit.
 * Side-effects: none (pure layout composition)
 * Notes: composerLeft slot positioned next to attachment button via CSS overlay.
 * Links: Wraps @/components/vendor/assistant-ui/thread
 * @public
 */

"use client";

import type { ReactNode } from "react";

import {
  Thread as VendorThread,
  type ThreadProps as VendorThreadProps,
} from "@/components/vendor/assistant-ui/thread";

export interface ThreadProps extends VendorThreadProps {
  /**
   * Optional content rendered in composer action bar, left side (after attachment button)
   * Use for model selection, voice controls, etc.
   */
  composerLeft?: ReactNode;
  /**
   * Optional error message rendered inline in the thread viewport
   * Appears as a message-like element in the chat flow
   */
  errorMessage?: ReactNode;
}

export function Thread({
  composerLeft,
  errorMessage,
  ...vendorProps
}: ThreadProps) {
  return (
    <div className="relative h-full">
      {/* Vendor Thread (pristine) */}
      <VendorThread {...vendorProps} errorMessage={errorMessage} />

      {/* Composer slot overlay - positioned in action bar next to attachment */}
      {composerLeft && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
          <div className="mx-auto w-full max-w-[var(--max-width-container-sm)] px-4 pb-4 md:pb-6">
            {/* Align with composer action bar (mt-2 mb-2 from vendor) */}
            <div className="mt-2 mb-2 flex items-center">
              {/* Spacer for attachment button - pointer-events-none to allow clicks through */}
              <div className="pointer-events-none w-[var(--size-composer-spacer)]" />
              {/* Enable pointer events only for our content */}
              <div className="pointer-events-auto">{composerLeft}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
