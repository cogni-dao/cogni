// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/profile/page`
 * Purpose: Server entrypoint for the user profile settings page.
 * Scope: Server component only; delegates all client-side behavior to ProfileView. Does not fetch data or use client hooks. Suspense boundary required for useSearchParams().
 * Invariants: Auth enforced by (app) layout guard.
 * Side-effects: none (server render only)
 * Links: src/app/(app)/profile/view.tsx
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { PageSkeleton } from "@/components";

import { ProfileView } from "./view";

export default function ProfilePage(): ReactElement {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProfileView />
    </Suspense>
  );
}
