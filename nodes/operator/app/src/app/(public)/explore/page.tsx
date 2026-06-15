// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/explore/page`
 * Purpose: Public exploration namespace entrypoint.
 * Scope: Server redirect only.
 * Side-effects: redirect
 * Links: src/app/(public)/explore/nodes/page.tsx
 * @public
 */

import { redirect } from "next/navigation";

export default function ExplorePage(): never {
  redirect("/explore/nodes");
}
