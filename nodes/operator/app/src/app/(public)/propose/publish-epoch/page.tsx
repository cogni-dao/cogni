// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/propose/publish-epoch/page`
 * Purpose: Public page for the publish-epoch distribution flow (deploy distributor + DAO early-execute mint).
 * Scope: Server component wrapper — renders the client component. No auth at the page level; the
 *   server build/persist routes enforce owner-or-`node.flight` RBAC.
 * Invariants: URL params (node, epochId) validated client-side; on-chain addresses fetched from the server build.
 * Side-effects: none (server component)
 * Links: ./publish-epoch.client.tsx, ../merge/page.tsx, story.5021
 * @public
 */

import { Suspense } from "react";

import { PageContainer } from "@/components/kit/layout/PageContainer";

import { PublishEpoch } from "./publish-epoch.client";

export default function PublishEpochPage() {
  return (
    <PageContainer maxWidth="2xl">
      <Suspense>
        <PublishEpoch />
      </Suspense>
    </PageContainer>
  );
}
