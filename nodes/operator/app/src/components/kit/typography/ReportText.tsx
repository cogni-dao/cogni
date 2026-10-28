// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@components/kit/typography/ReportText`
 * Purpose: Compact administrative typography using existing semantic tokens.
 * Scope: Presentational text only; no report logic or IO.
 * Invariants: Semantic element and visual hierarchy are independent; className is layout-only.
 * Side-effects: none
 * Links: docs/spec/ui-implementation.md
 * @public
 */
import type { VariantProps } from "class-variance-authority";
import { createElement, type HTMLAttributes } from "react";
import { reportText } from "@/styles/ui";

interface ReportTextProps
  extends HTMLAttributes<HTMLElement>,
    VariantProps<typeof reportText> {
  as?: "h1" | "h2" | "h3" | "p" | "span" | "dt" | "dd";
}
export function ReportText({
  as = "p",
  variant,
  tone,
  className,
  ...props
}: ReportTextProps) {
  return createElement(as, {
    ...props,
    className: reportText({ variant, tone, className }),
  });
}
