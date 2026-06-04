// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/page`
 * Purpose: Redirect — governance landing page is the ownership view.
 * Scope: Redirect only. No data fetching or rendering.
 * Invariants: 308 permanent redirect to /gov/holdings.
 * Side-effects: none
 * @public
 */

import { permanentRedirect } from "next/navigation";

export default function GovernancePage() {
  permanentRedirect("/gov/holdings");
}
