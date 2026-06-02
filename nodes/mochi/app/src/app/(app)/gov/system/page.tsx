// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/system/page`
 * Purpose: Server entrypoint for system activity page within governance.
 * Scope: Server component only; delegates all client behavior to GovernanceView. Does not perform data fetching.
 * Invariants: Auth enforced by (app) layout guard.
 * Side-effects: none (server render only)
 * Links: docs/spec/governance-status-api.md
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { PageSkeleton } from "@/components";

import { GovernanceView } from "./view";

export default function SystemActivityPage(): ReactElement {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <GovernanceView />
    </Suspense>
  );
}
