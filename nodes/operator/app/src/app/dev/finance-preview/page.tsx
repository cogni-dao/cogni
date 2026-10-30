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
import { getEnv } from "@/shared/env";
import { FinancePreview } from "./Preview.client";

export default function FinancePreviewPage(): ReactElement {
  if (getEnv("NODE_ENV") !== "development") notFound();
  return <FinancePreview />;
}
