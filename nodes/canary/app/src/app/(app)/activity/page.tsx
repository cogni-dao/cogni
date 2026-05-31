// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/activity/page`
 * Purpose: Permanent redirect — activity is now part of the dashboard.
 * Scope: Redirect only. No data fetching or rendering.
 * Invariants: 308 permanent redirect to /dashboard.
 * Side-effects: none
 * @public
 */

import { permanentRedirect } from "next/navigation";

export default function ActivityPage() {
  permanentRedirect("/dashboard");
}
