// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/util/cn`
 * Purpose: Merge conditional class names with Tailwind-aware deduplication.
 * Scope: Wraps clsx + tailwind-merge for reuse across kit + feature layers; Does not import design tokens or component code.
 * Invariants: Returns a single string; filters falsy values; merges Tailwind conflicts.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/frontend-development
 * @public
 */

import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
