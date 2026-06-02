// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/util`
 * Purpose: Public surface for shared utilities — app-local cn() + extracted (@cogni/node-shared) uuid.
 * Scope: Re-exports public utility functions.
 * Invariants: No circular dependencies.
 * Side-effects: none
 * @public
 */

// Extracted to @cogni/node-shared
// NOTE: accountId.ts uses node:crypto — import directly, not through barrel
export { isValidUuid } from "@cogni/node-shared";
// App-local (clsx + tailwind-merge UI dep)
