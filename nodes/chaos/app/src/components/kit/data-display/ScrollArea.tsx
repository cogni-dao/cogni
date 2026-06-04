// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/ScrollArea`
 * Purpose: Kit re-export of shadcn ScrollArea primitive for stable API surface.
 * Scope: Thin re-export wrapper. Does not modify behavior or styling.
 * Invariants: Vendor component remains quarantined; kit provides stable import path.
 * Side-effects: none
 * Notes: Compositional primitive re-exported for features layer access.
 * Links: Wraps @/components/vendor/shadcn/scroll-area
 * @public
 */

export { ScrollArea, ScrollBar } from "@cogni/node-ui-kit/shadcn/scroll-area";
