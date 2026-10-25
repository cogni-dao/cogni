// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/dev/finance-preview/page`
 * Purpose: Preview the real finance component using visibly synthetic data in local development.
 * Scope: No auth bypass and no live adapters; unavailable outside development.
 * Invariants: Production and test return 404 before rendering fixtures.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import { notFound } from "next/navigation";
import type { ReactElement } from "react";

import { PageContainer } from "@/components";
import { FinanceReport } from "@/features/finance/components/FinanceReport";
import { getEnv } from "@/shared/env";

import { financePreview } from "./fixture";

export default function FinancePreviewPage(): ReactElement {
  if (getEnv("NODE_ENV") !== "development") notFound();
  return (
    <PageContainer maxWidth="full">
      <div className="mx-auto max-w-7xl space-y-6">
        <p className="rounded-lg border p-4 font-medium text-sm">
          Demo data — layout preview. These are synthetic balances and costs.
        </p>
        <FinanceReport report={financePreview} />
      </div>
    </PageContainer>
  );
}
