// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `reporting-page.test`
 * Purpose: Prove real grid sorting, compact totals, evidence disclosure and access guards.
 * Scope: Actual ReUI/TanStack rendering with no live providers or app shell IO.
 * Invariants: Missing-last both ways, native economic buckets, no money-moving controls.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  allowed: false,
  readers: vi.fn(async () => ({
    readers: [],
    treasuryPlane: null,
    costRateEvidence: [],
  })),
  log: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: access.refresh }),
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
vi.mock("@/app/(admin)/AdminShell", () => ({
  AdminShell: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));
vi.mock("@/components", async () => {
  const grid = await import("@cogni/node-ui-kit/reui/data-grid/data-grid");
  const header = await import(
    "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header"
  );
  const table = await import(
    "@cogni/node-ui-kit/reui/data-grid/data-grid-table"
  );
  return {
    ...grid,
    ...header,
    ...table,
    Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: string;
      size?: string;
    }) => <button {...props} />,
    PageContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

import { getFinanceReport } from "@/app/(admin)/admin/payments/finance.server";
import { financePreview } from "@/app/dev/finance-preview/fixture";
import FinancePreviewPage from "@/app/dev/finance-preview/page";
import { FinanceReport } from "@/features/finance/components/FinanceReport";
import { amountLabel } from "@/features/finance/components/format";

function services(): string[] {
  const body = screen.getByRole("table").querySelector("tbody");
  return Array.from(body?.querySelectorAll("tr") ?? []).map(
    (row) => row.querySelector("td span")?.textContent ?? ""
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Payments reporting", () => {
  it("denies unauthorized reads before constructing readers", async () => {
    access.allowed = false;
    access.readers.mockClear();
    await expect(getFinanceReport()).rejects.toThrow("NEXT_REDIRECT");
    expect(access.readers).not.toHaveBeenCalled();
  });
  it("emits only coverage after an authorized read", async () => {
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
  it("shows only DAO treasury above a Costs grid, with other custody collapsed", () => {
    render(<FinanceReport report={financePreview} />);
    expect(screen.getByRole("heading", { name: "Financials" })).toBeVisible();
    expect(
      screen.getByText("DAO treasury", { selector: "dt" }).nextElementSibling
    ).toHaveTextContent("10 USDC");
    expect(services()).not.toContain("DAO treasury");
    expect(services()).not.toContain("Operator working capital");
    expect(
      screen.getByText("Funding accounts").parentElement
    ).not.toHaveAttribute("open");
    expect(
      screen.queryByRole("button", { name: /Paid/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Known Akash contract rate · operator fleet")
    ).toBeVisible();
    expect(screen.getByText("0.000005 USD credit / block")).toBeVisible();
    expect(
      screen.getAllByText("Last known · age unknown").length
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /^(fund|pay bill|top up)$/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Provider transfers · cumulative")
    ).not.toBeInTheDocument();
  });
  it.each([
    "Balance / credit",
    "Runway",
    "Rate",
  ])("sorts %s numerically both ways with missing last", (title) => {
    render(<FinanceReport report={financePreview} />);
    const selected = () =>
      services().filter((name) => name.startsWith("Example service"));
    const sort = screen.getByRole("button", { name: title, exact: true });
    fireEvent.click(sort);
    expect(selected()).toEqual(["Example service A", "Example service B"]);
    expect(services().slice(-2)).toEqual(["Grafana", "GitHub"]);
    fireEvent.click(sort);
    expect(selected()).toEqual(["Example service B", "Example service A"]);
    expect(services().slice(-2)).toEqual(["Grafana", "GitHub"]);
  });
  it("never replaces missing DAO treasury with another custody account", () => {
    render(
      <FinanceReport report={{ ...financePreview, treasuryPlane: null }} />
    );
    expect(
      screen.getByText("DAO treasury", { selector: "dt" }).nextElementSibling
    ).toHaveTextContent("—");
  });
  it("opens exact evidence by keyboard and refreshes without payment actions", async () => {
    render(<FinanceReport report={financePreview} />);
    const details = screen.getAllByRole("button", {
      name: "Show Akash hosting details",
    })[0];
    if (!details) throw new Error("Missing details");
    details.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Provider transfers · cumulative")).toBeVisible();
    expect(screen.getByText(/1250000 uact/)).toBeVisible();
    expect(screen.getByText("Exact native rate")).toBeVisible();
    expect(screen.queryByText("Supplied daily burn")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(access.refresh).toHaveBeenCalled();
  });
  it("shows tiny positive native values as nonzero", () => {
    expect(amountLabel({ amount: "0.00001", currency: "uact" })).toBe(
      "<0.000001 USD compute credit"
    );
  });
  it("discloses supplied precision and distinct observation timestamps only in Details", () => {
    const source = financePreview.rows.find(
      (row) => row.label === "OpenRouter"
    );
    if (!source) throw new Error("Missing fixture");
    render(
      <FinanceReport
        report={{
          ...financePreview,
          rows: [
            {
              ...source,
              balance: 1.23456789,
              currency: "USD",
              burnPerDay: 0.00000001,
              nativeRate: undefined,
              sourceObservedAt: "2026-10-24T12:00:00.000Z",
              observedAt: "2026-10-24T12:05:00.000Z",
            },
          ],
        }}
      />
    );
    expect(screen.queryByText("1.23456789 USD")).not.toBeInTheDocument();
    expect(screen.queryByText("1e-8 USD / day")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show OpenRouter details" })
    );
    expect(screen.getByText("1.23456789 USD")).toBeVisible();
    expect(screen.getByText("1e-8 USD / day")).toBeVisible();
    expect(
      screen.getByText("Source observed").nextElementSibling
    ).toHaveTextContent("2026-10-24 12:00 UTC");
    expect(screen.getByText("Read at").nextElementSibling).toHaveTextContent(
      "2026-10-24 12:05 UTC"
    );
  });
  it.each(["production", "test"])("preview returns 404 in %s", (env) => {
    vi.stubEnv("NODE_ENV", env);
    expect(() => FinancePreviewPage()).toThrow("NEXT_NOT_FOUND");
  });
  it("labels the same component preview as demo data", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(FinancePreviewPage());
    expect(screen.getByText("Demo data")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Costs" })).toBeVisible();
  });
});
