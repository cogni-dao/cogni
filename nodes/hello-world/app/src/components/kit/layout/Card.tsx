// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/Card`
 * Purpose: Card container component with header, content, and footer sections.
 * Scope: Stable kit API wrapping shadcn card primitive. Does not add behavior.
 * Invariants: Forwards all props to vendor implementation; maintains ref forwarding.
 * Side-effects: none
 * Notes: Vendor implementation at src/components/vendor/shadcn/card.tsx
 * Links: https://ui.shadcn.com/docs/components/card
 * @public
 */

// Upstream: shadcn/ui card component
// Our code now, but keep link for reference
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@cogni/node-ui-kit/shadcn/card";
