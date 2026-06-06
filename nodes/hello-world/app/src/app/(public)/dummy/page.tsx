// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/dummy/page`
 * Purpose: Demo page route for Credits UI reference implementation.
 * Scope: Public route serving CreditsBody demo component. Does not require authentication or handle actual transactions.
 * Invariants: Static demo only; no backend interaction.
 * Side-effects: none
 * Notes: Used as visual reference for component system migration
 * Links: CreditsBody.client.tsx
 * @public
 */

import type { ReactElement } from "react";

import { CreditsBody } from "./CreditsBody.client";

export default function DummyPage(): ReactElement {
  return <CreditsBody />;
}
