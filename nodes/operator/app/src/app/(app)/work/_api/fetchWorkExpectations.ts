// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { WorkExpectationPage, WorkMetric } from "@cogni/knowledge-base-ui";

/** One bounded server projection, authenticated for every read. */
export async function fetchWorkExpectations(
  id: string,
  signal: AbortSignal,
  _moves: readonly WorkMetric[]
): Promise<WorkExpectationPage> {
  const response = await fetch(
    `/api/v1/work/items/${encodeURIComponent(id)}/expectations`,
    {
      signal,
      credentials: "same-origin",
      cache: "no-store",
    }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<WorkExpectationPage>;
}
