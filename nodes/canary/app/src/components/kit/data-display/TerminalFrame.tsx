// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/TerminalFrame`
 * Purpose: Stateless terminal frame with CVA styling for code display and interactive terminals.
 * Scope: Provides terminal chrome and slots content. Does not handle state, animation, or clipboard.
 * Invariants: Forwards all props except className; maintains ref forwarding; blocks className prop.
 * Side-effects: none
 * Notes: Uses CVA factories from \@/styles/ui - no literal classes allowed.
 * Links: src/styles/ui.ts, docs/spec/ui-implementation.md
 * \@public
 */

"use client";

import type { VariantProps } from "class-variance-authority";
import { Check, Copy } from "lucide-react";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";

import {
  icon,
  iconButton,
  row,
  terminalBody,
  terminalDot,
  terminalFrame,
  terminalHeader,
} from "@/styles/ui";

type DivNoClass = Omit<HTMLAttributes<HTMLDivElement>, "className">;

export interface TerminalFrameProps
  extends DivNoClass,
    VariantProps<typeof terminalFrame> {
  onCopy?: () => void;
  copied?: boolean;
  children: ReactNode;
}

export function TerminalFrame({
  surface,
  size,
  onCopy,
  copied,
  children,
  ...props
}: TerminalFrameProps): ReactElement {
  return (
    <div className={terminalFrame({ surface, size })} {...props}>
      <div className={terminalHeader()}>
        <div className={row({ gap: "xs" })}>
          <span className={terminalDot({ color: "red" })} />
          <span className={terminalDot({ color: "yellow" })} />
          <span className={terminalDot({ color: "green" })} />
        </div>
        <button
          type="button"
          onClick={onCopy}
          className={iconButton()}
          aria-label="Copy to clipboard"
        >
          {copied ? (
            <Check className={icon({ size: "md" })} />
          ) : (
            <Copy className={icon({ size: "md" })} />
          )}
        </button>
      </div>
      <div className={terminalBody()}>{children}</div>
    </div>
  );
}
