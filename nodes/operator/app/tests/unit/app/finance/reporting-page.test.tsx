// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `reporting-page.test`
 * Purpose: Prove read-only evidence rendering and fixture-preview production denial.
 * Scope: SSR component rendering and page guard with no live adapters.
 * Invariants: Unknown is not zero, cumulative evidence is not payment history, no write controls.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const access = vi.hoisted(() => ({
  allowed: false,
  readers: vi.fn(async () => []),
  log: vi.fn(),
}));
vi.mock("@/bootstrap/capabilities/finance", () => ({
  createFinanceReaders: access.readers,
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => ({ walletAddress: "0xexample" }),
}));
vi.mock("@/shared/config", () => ({
  isDaoAdmin: () => access.allowed,
  getNodeId: () => "operator",
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { FINANCE_REPORT_READ: "finance.report.read" },
  makeLogger: () => ({ info: access.log }),
}));

vi.mock("@/components", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  Table: ({ children }: { children: React.ReactNode }) => (
    <table>{children}</table>
  ),
  TableBody: ({ children }: { children: React.ReactNode }) => (
    <tbody>{children}</tbody>
  ),
  TableCell: ({ children }: { children: React.ReactNode }) => (
    <td>{children}</td>
  ),
  TableHead: ({ children }: { children: React.ReactNode }) => (
    <th>{children}</th>
  ),
  TableHeader: ({ children }: { children: React.ReactNode }) => (
    <thead>{children}</thead>
  ),
  TableRow: ({ children }: { children: React.ReactNode }) => (
    <tr>{children}</tr>
  ),
  PageContainer: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

import { getFinanceReport } from "@/app/(admin)/admin/payments/finance.server";
import { financePreview } from "@/app/dev/finance-preview/fixture";
import FinancePreviewPage from "@/app/dev/finance-preview/page";
import { FinanceReport } from "@/features/finance/components/FinanceReport";

afterEach(() => vi.unstubAllEnvs());

describe("finance report", () => {
  it("denies unauthorized finance reads before constructing provider readers", async () => {
    access.allowed = false;
    access.readers.mockClear();
    await expect(getFinanceReport()).rejects.toThrow("NEXT_REDIRECT");
    expect(access.readers).not.toHaveBeenCalled();
  });
  it("emits only coverage evidence after an authorized read", async () => {
    access.allowed = true;
    await expect(getFinanceReport()).resolves.toMatchObject({ rows: [] });
    expect(access.log).toHaveBeenCalledWith(
      {
        event: "finance.report.read",
        rowCount: 0,
        unknownCount: 0,
        transferredRows: 0,
      },
      "Finance report read"
    );
  });
  it("renders native evidence with custody and coverage rather than a misleading total", () => {
    const html = renderToStaticMarkup(
      <FinanceReport report={financePreview} />
    );
    expect(html).toContain("12.5 uact / block");
    expect(html).toContain("1250000");
    expect(html).toContain("Source age unknown");
    expect(html).toContain("Operator covered");
    expect(html).toContain("Human-custodied wallet");
    expect(html).toContain("Individual payment history is not available");
    expect(html).toContain("Not measured");
    expect(html).not.toContain("<button");
  });
  it.each(["production", "test"])("preview returns 404 in %s", (env) => {
    vi.stubEnv("NODE_ENV", env);
    expect(() => FinancePreviewPage()).toThrow("NEXT_NOT_FOUND");
  });
  it("explicitly labels local data synthetic", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(FinancePreviewPage());
    expect(html).toContain("Demo data — layout preview");
    expect(html).toContain("synthetic balances and costs");
  });
});
