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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  allowed: false,
  readers: vi.fn(async () => []),
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
    (row) =>
      row.querySelector("td")?.textContent?.replace("Sponsored", "") ?? ""
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
  it("starts with urgent rows and displays meaningful, currency-separated totals", () => {
    render(<FinanceReport report={financePreview} />);
    expect(services().slice(0, 3)).toEqual([
      "Akash hosting",
      "Cherry compute",
      "Grafana",
    ]);
    expect(screen.getAllByText("95 USDC")).toHaveLength(2);
    expect(screen.getAllByText("6 ACT · 36 EUR · 120 USD")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Paid (cumulative)", exact: true })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /fund|pay bill/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
  });
  it("sorts numeric balances both ways and leaves missing balances last", () => {
    render(<FinanceReport report={financePreview} />);
    const sort = screen.getByRole("button", { name: "Balance", exact: true });
    fireEvent.click(sort);
    expect(
      services().filter((name) =>
        [
          "Steward custody",
          "Operator working capital",
          "DAO treasury",
        ].includes(name)
      )
    ).toEqual(["Steward custody", "Operator working capital", "DAO treasury"]);
    expect(services().slice(-2)).toEqual(["Grafana", "GitHub"]);
    fireEvent.click(sort);
    expect(
      services().filter((name) =>
        [
          "Steward custody",
          "Operator working capital",
          "DAO treasury",
        ].includes(name)
      )
    ).toEqual(["DAO treasury", "Operator working capital", "Steward custody"]);
    expect(services().slice(-2)).toEqual(["Grafana", "GitHub"]);
  });
  it("sorts runway both ways and keeps unknown runway below measured days", () => {
    render(<FinanceReport report={financePreview} />);
    const sort = screen.getByRole("button", { name: "Runway", exact: true });
    fireEvent.click(sort);
    expect(services().slice(0, 3)).toEqual([
      "Akash hosting",
      "Cherry compute",
      "OpenRouter",
    ]);
    fireEvent.click(sort);
    expect(services().slice(0, 3)).toEqual([
      "OpenRouter",
      "Cherry compute",
      "Akash hosting",
    ]);
  });
  it("sorts burn and cumulative paid numerically within one native currency", () => {
    const source = financePreview.rows.find(
      (row) => row.label === "OpenRouter"
    );
    if (!source) throw new Error("Missing fixture");
    render(
      <FinanceReport
        report={{
          ...financePreview,
          rows: [
            ...financePreview.rows,
            {
              ...source,
              plane: "demo:other-ai",
              label: "Other AI",
              burnPerDay: 12,
              cumulativeVendorTransfer: { amount: "20", currency: "USD" },
            },
          ],
        }}
      />
    );
    const selected = () =>
      services().filter((name) => ["OpenRouter", "Other AI"].includes(name));
    fireEvent.click(screen.getByRole("button", { name: "Burn", exact: true }));
    expect(selected()).toEqual(["OpenRouter", "Other AI"]);
    fireEvent.click(screen.getByRole("button", { name: "Burn", exact: true }));
    expect(selected()).toEqual(["Other AI", "OpenRouter"]);
    expect(services().slice(-2)).toEqual(["Grafana", "GitHub"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Paid (cumulative)", exact: true })
    );
    expect(selected()).toEqual(["Other AI", "OpenRouter"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Paid (cumulative)", exact: true })
    );
    expect(selected()).toEqual(["OpenRouter", "Other AI"]);
    expect(services().slice(-2)).toEqual(["Grafana", "GitHub"]);
  });
  it("opens exact evidence by keyboard and refreshes without payment actions", async () => {
    render(<FinanceReport report={financePreview} />);
    const details = screen.getByRole("button", {
      name: "Show Akash hosting details",
    });
    details.focus();
    await userEvent.keyboard("{Enter}");
    expect(
      screen.getByText("Paid · cumulative provider transfer")
    ).toBeVisible();
    expect(screen.getByText("1250000 uact")).toBeVisible();
    expect(screen.getByText("Exact native rate")).toBeVisible();
    expect(screen.queryByText("Supplied daily burn")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(access.refresh).toHaveBeenCalled();
  });
  it("shows tiny positive native values as nonzero", () => {
    expect(amountLabel({ amount: "0.00001", currency: "uact" })).toBe(
      "<0.000001 ACT"
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
    expect(
      within(screen.getByRole("table")).getByText("Known totals")
    ).toBeVisible();
  });
});
