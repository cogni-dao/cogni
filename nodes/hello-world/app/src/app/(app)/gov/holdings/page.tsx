// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/holdings/page`
 * Purpose: Server entrypoint for the holdings and ownership page.
 * Scope: Server component only; delegates all client behavior to HoldingsView. Does not perform data fetching.
 * Invariants: Auth enforced by (app) layout guard.
 * Side-effects: none (server render only)
 * Links: src/features/governance/types.ts
 * @public
 */

import type { ReactElement } from "react";

import { HoldingsView } from "./view";

export default function HoldingsPage(): ReactElement {
  return <HoldingsView />;
}
