// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/dao/page`
 * Purpose: Legacy DAO formation URL. Redirects to the registry-aware node wizard.
 * Scope: Server redirect only; node birth must start from a DB-backed node row.
 * Invariants: Requires authenticated session (wallet connected) via (app) route group.
 * Side-effects: redirect
 * Links: docs/spec/node-formation.md
 * @public
 */

import { redirect } from "next/navigation";

export default function DAOFormationPage(): never {
  redirect("/setup/nodes");
}
