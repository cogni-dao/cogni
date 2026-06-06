// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/typography/Prompt`
 * Purpose: Terminal prompt component wrapper with CVA styling API for command prompt display.
 * Scope: Provides typed prompt variants wrapping CVA factories. Does not handle terminal logic or commands.
 * Invariants: Forwards all props except className to span element; maintains ref forwarding; blocks className prop.
 * Side-effects: none
 * Notes: Uses CVA factory from \@/styles/ui - no literal classes allowed.
 * Links: src/styles/ui.ts, docs/spec/ui-implementation.md
 * @public
 */

"use client";

import type { VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { forwardRef } from "react";

import { prompt } from "@/styles/ui";

type SpanNoClass = Omit<HTMLAttributes<HTMLSpanElement>, "className">;

export interface PromptProps extends SpanNoClass, VariantProps<typeof prompt> {}

export const Prompt = forwardRef<HTMLSpanElement, PromptProps>(
  ({ tone, ...props }, ref) => (
    <span ref={ref} className={prompt({ tone })} {...props} />
  )
);
Prompt.displayName = "Prompt";
