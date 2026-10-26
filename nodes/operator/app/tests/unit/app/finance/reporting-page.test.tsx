// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `reporting-page.test`
 * Purpose: Prove the operator renders the package FinanceReport (ONE_UI): grouped five-column table in USD, expandable
 *   children, rail-driven actions incl. the fund-steward POST, the Line dialog, the one summary line, and access guards.
 * Scope: Real kit + package component in jsdom; no live providers or app shell IO.
 * Invariants: Unknown is a dash with a reason behind the Line dialog; a non-supported rail is never clickable.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @vitest-environment jsdom
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  allowed: false,
  readers: vi.fn(async () => ({
    readers: [] as unknown[],
    treasuryPlane: null as string | null,
    stewardWalletUrl: null as string | null,
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
vi.mock("@/bootstrap/capabilities/finance", async () => {
  const adapter = await import(
    "@/adapters/server/finance/operator-finance.adapter"
  );
  return {
    createFinanceReaders: access.readers,
    collapseAkash: adapter.collapseAkash,
  };
});
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
  const dialog = await import("@cogni/node-ui-kit/shadcn/dialog");
  const select = await import("@cogni/node-ui-kit/shadcn/select");
  const text = await import("@/components/kit/typography/ReportText");
  const button = await import("@/components/kit/inputs/Button");
  const input = await import("@/components/kit/inputs/Input");
  const card = await import("@/components/kit/layout/Card");
  return {
    ...dialog,
    ...select,
    ...text,
    ...button,
    ...input,
    ...card,
    PageContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

import type { MoneyPlaneRow } from "@cogni/money-plane";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { getFinanceReport } from "@/app/(admin)/admin/payments/finance.server";
import FinancePage from "@/app/(admin)/admin/payments/page";
import {
  liveShapedFinancePreview,
  sparseFinancePreview,
  withIncomeFinancePreview,
} from "@/app/dev/finance-preview/fixture";
import { FixtureQueryBoundary } from "@/app/dev/finance-preview/Preview.client";
import FinancePreviewPage from "@/app/dev/finance-preview/page";
import { FinanceReportClient } from "@/features/finance/components/FinanceReportClient";
import type { FinanceReportModel } from "@/features/finance/types";
import { useTreasurySnapshot } from "@/features/treasury/hooks/useTreasurySnapshot";

function grid() {
  return within(screen.getByRole("region", { name: "Financials table" }));
}
function headers(): string[] {
  return Array.from(screen.getByRole("table").querySelectorAll("thead th")).map(
    (th) => th.textContent?.replace(/[▲▼⇅]/g, "").trim() ?? ""
  );
}
function bodyRows(): HTMLElement[] {
  return Array.from(
    screen
      .getByRole("table")
      .querySelectorAll<HTMLElement>("tbody tr[data-finance-row]")
  );
}
function lines(): string[] {
  return bodyRows().map((row) => row.getAttribute("data-finance-row") ?? "");
}
function labels(): string[] {
  return bodyRows().map(
    (row) =>
      Array.from(row.querySelectorAll<HTMLElement>("td button[aria-label]"))
        .map((b) => b.getAttribute("aria-label") ?? "")
        .find((name) => !/^(Expand|Collapse) /.test(name)) ?? ""
  );
}
function cells(column: number): string[] {
  return bodyRows().map(
    (row) => row.querySelectorAll("td")[column]?.textContent?.trim() ?? ""
  );
}
function rowOf(plane: string): HTMLElement {
  const row = bodyRows().find(
    (r) => r.getAttribute("data-finance-row") === plane
  );
  if (!row) throw new Error(`Missing row ${plane}`);
  return row;
}
function groupsInOrder(): string[] {
  return Array.from(
    screen.getByRole("table").querySelectorAll("tbody tr[data-finance-group]")
  ).map((tr) => tr.getAttribute("data-finance-group") ?? "");
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  access.refresh.mockReset();
});

describe("Financials reporting", () => {
  it("denies unauthorized reads before constructing readers", async () => {
    access.allowed = false;
    access.readers.mockClear();
    await expect(getFinanceReport()).rejects.toThrow("NEXT_REDIRECT");
    expect(access.readers).not.toHaveBeenCalled();
  });
  it("emits only coverage after an authorized read and summarizes an empty snapshot", async () => {
    access.allowed = true;
    await expect(getFinanceReport()).resolves.toMatchObject({
      rows: [],
      treasuryPlane: null,
      stewardWalletUrl: null,
      summary: { treasuryUsd: null, burnPerDay: null, incomePerDay: null },
    });
    expect(access.log).toHaveBeenCalledWith(
      {
        event: "finance.report.read",
        rowCount: 0,
        unknownCount: 0,
        transferredRows: 0,
        ratesUsed: [],
      },
      "Finance report read"
    );
  });
  it("renders the package table in USD: five columns, Income · Costs · Reserves, one summary, one FX line", () => {
    render(<FinanceReportClient report={liveShapedFinancePreview} />);
    expect(screen.getByRole("heading", { name: "Financials" })).toBeVisible();
    expect(screen.getByText(/^Refreshed /)).toBeVisible();
    expect(headers()).toEqual([
      "Line",
      "Balance",
      "Burn/day",
      "Runway",
      "Action",
    ]);
    expect(groupsInOrder()).toEqual(["Income", "Costs", "Reserves"]);
    const stat = (label: string) =>
      document.querySelector(`[data-finance-stat='${label}']`)?.textContent;
    expect(stat("Treasury")).toBe("$74.52");
    expect(stat("Cash received")).toBe("$0.00/day");
    expect(stat("Burn")).toBe("$13.23/day");
    // DAO runway = treasury ÷ net burn (74.52 ÷ 13.23 ≈ 5.6d); the Akash deadline is a separate line.
    expect(stat("Runway")).toBe("5d");
    expect(screen.getByText("treasury ÷ net burn")).toBeVisible();
    const deadline = document.querySelector("[data-finance-deadline]");
    expect(deadline?.textContent).toBe("Next deadline 2d · Akash");
    expect(deadline?.className).toContain("text-destructive");
    expect(screen.getByText("USDC on Base")).toBeVisible();
    expect(screen.getByText("credit purchases · 30d")).toBeVisible();
    expect(screen.getByText("EUR→USD 1.1188 · ECB 2026-10-26")).toBeVisible();
    expect(cells(1)).toContain("$13.87");
    expect(cells(2)).toContain("$0.38/day");
    expect(cells(2)).toContain("$9.72/day");
    expect(screen.queryByText(/€/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Paid by Operator/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Payment history/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider funding/i)).not.toBeInTheDocument();
    expect(lines()).not.toContain("akash:poly");
  });
  it("orders each group by risk and lists income first", () => {
    render(<FinanceReportClient report={withIncomeFinancePreview} />);
    expect(labels()).toEqual([
      "Credit purchases",
      "Node services",
      "Akash",
      "Cherry credit",
      "Domain cognidao.org",
      "Grafana overage",
      "Alchemy RPC",
      "OpenRouter credit",
      "Other SaaS",
      "System tenant",
      "DAO treasury",
      "Operator wallet",
      "Steward wallet",
    ]);
    expect(
      document.querySelector("[data-finance-stat='Cash received']")?.textContent
    ).toBe("$1.50/day");
    // Income lengthens DAO runway: 74.52 ÷ (13.23 − 1.50) ≈ 6.4d.
    expect(
      document.querySelector("[data-finance-stat='Runway']")?.textContent
    ).toBe("6d");
    const red = within(rowOf("akash:credit")).getByText("2d");
    expect(red.className).toContain("text-destructive");
    expect(within(rowOf("cherry:team")).getByText("36d").className).toContain(
      "text-success"
    );
  });
  it("expands a parent's children on the chevron and never shows them as top-level rows", async () => {
    render(<FinanceReportClient report={liveShapedFinancePreview} />);
    expect(
      screen.getByRole("table").querySelectorAll("tr[data-finance-child]")
    ).toHaveLength(0);
    await userEvent.click(
      grid().getByRole("button", { name: "Expand Akash", exact: true })
    );
    const children = Array.from(
      screen.getByRole("table").querySelectorAll("tr[data-finance-child]")
    ).map((tr) => tr.getAttribute("data-finance-child"));
    expect(children).toEqual([
      "akash:poly",
      "akash:red",
      "akash:toks5",
      "akash:levelup",
      "akash:beacon",
      "akash:node-template",
    ]);
    const poly = screen
      .getByRole("table")
      .querySelector("tr[data-finance-child='akash:poly']");
    expect(poly?.textContent).toContain("$1.57/day");
    expect(
      grid().getByRole("button", { name: "Collapse Akash", exact: true })
    ).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(
      grid().getByRole("button", { name: "Expand Other SaaS", exact: true })
    );
    expect(
      screen
        .getByRole("table")
        .querySelector("tr[data-finance-child='saas:posthog']")
    ).not.toBeNull();
  });
  it("renders rails: live controls only when supported, greyed labels otherwise, with the gap in the dialog", async () => {
    render(<FinanceReportClient report={liveShapedFinancePreview} />);
    expect(
      within(rowOf("base:operator-wallet")).getByRole("button", {
        name: "Fund steward",
      })
    ).toBeVisible();
    expect(
      within(rowOf("openrouter:account")).getByRole("link", { name: /Top up/ })
    ).toHaveAttribute("href", "https://openrouter.ai/settings/credits");
    expect(
      within(rowOf("cherry:team")).getByRole("link", { name: /Top up/ })
    ).toHaveAttribute("href", "https://portal.cherryservers.com/");
    const akash = rowOf("akash:credit");
    expect(within(akash).queryByRole("link")).not.toBeInTheDocument();
    expect(within(akash).getByText("Card · Console")).toBeVisible();
    expect(
      within(rowOf("grafana:overage")).getByText("Card · auto-bill")
    ).toBeVisible();
    expect(
      within(rowOf("base:dao-treasury")).getByText("DAO vote")
    ).toBeVisible();
    expect(within(rowOf("rpc:alchemy")).getByText("No rail")).toBeVisible();
    expect(
      within(rowOf("income:credit-purchases")).getByText("Split · auto")
    ).toBeVisible();
    await userEvent.click(
      grid().getByRole("button", { name: "Akash", exact: true })
    );
    const dialog = screen.getByRole("dialog", { name: "Akash" });
    expect(
      within(dialog).getByText(
        /paid by card, not from the steward wallet · planned/
      )
    ).toBeVisible();
    expect(
      within(dialog).getByText("5.79 USD credit (5,790,000 uact)")
    ).toBeVisible();
    expect(
      within(dialog).getByText("2.10 USD credit (2,100,000 uact)")
    ).toBeVisible();
  });
  it("shows native exact amounts and the conversion in the Line dialog, closes with Escape and restores focus", async () => {
    render(<FinanceReportClient report={liveShapedFinancePreview} />);
    const trigger = grid().getByRole("button", {
      name: "Cherry credit",
      exact: true,
    });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Cherry credit" });
    expect(within(dialog).getByText("12.4 EUR")).toBeVisible();
    expect(
      within(dialog).getByText("EUR→USD 1.1188 · ECB 2026-10-26")
    ).toBeVisible();
    expect(within(dialog).getByText(/balance ÷ burn/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.click(
      grid().getByRole("button", { name: "Operator wallet", exact: true })
    );
    expect(
      within(screen.getByRole("dialog")).getByText(
        "User payments → operator wallet → steward wallet → vendors"
      )
    ).toBeVisible();
  });
  it("fund-steward POSTs the amount only and shows the tx link or the server error", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { amountUsd: number };
      return body.amountUsd === 2.5
        ? {
            ok: true,
            status: 200,
            json: async () => ({ txHash: "0xabcdef1234567890" }),
          }
        : {
            ok: false,
            status: 400,
            json: async () => ({ detail: "amount too large" }),
          };
    });
    vi.stubGlobal("fetch", fetch);
    render(<FinanceReportClient report={liveShapedFinancePreview} />);
    const operator = rowOf("base:operator-wallet");
    const amount = within(operator).getByRole("spinbutton", {
      name: "Fund steward (USD)",
    });
    await userEvent.clear(amount);
    await userEvent.type(amount, "2.5");
    await userEvent.click(
      within(operator).getByRole("button", { name: "Fund steward" })
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/payments/steward-withdrawal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ amountUsd: 2.5 }),
      })
    );
    expect(
      await within(operator).findByRole("link", { name: /Sent 0xabcd…7890/ })
    ).toHaveAttribute("href", "https://basescan.org/tx/0xabcdef1234567890");
    await userEvent.clear(amount);
    await userEvent.type(amount, "999");
    await userEvent.click(
      within(operator).getByRole("button", { name: "Fund steward" })
    );
    expect(await within(operator).findByRole("alert")).toHaveTextContent(
      "amount too large"
    );
  });
  it("drops all-dash numeric columns in the sparse scenario and explains rows behind the Line dialog", async () => {
    render(<FinanceReportClient report={sparseFinancePreview} />);
    expect(headers()).toEqual(["Line", "Balance", "Action"]);
    expect(new Set(cells(1))).toEqual(new Set(["—"]));
    expect(
      document.querySelector("[data-finance-stat='Treasury']")?.textContent
    ).toBe("—");
    expect(screen.queryByText(/ECB/)).not.toBeInTheDocument();
    await userEvent.click(
      grid().getByRole("button", { name: "DAO treasury", exact: true })
    );
    expect(
      within(screen.getByRole("dialog")).getByText(/RPC unavailable/)
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      grid().getByRole("button", { name: "Akash", exact: true })
    );
    expect(
      within(screen.getByRole("dialog")).getByText(/Akash chain read failed/)
    ).toBeVisible();
  });
  it("sorts a numeric column both ways within groups and keeps unmeasured last", () => {
    render(<FinanceReportClient report={liveShapedFinancePreview} />);
    const sort = grid().getByRole("button", { name: "Burn/day", exact: true });
    fireEvent.click(sort);
    const costs = () =>
      bodyRows()
        .filter(
          (r) =>
            r.getAttribute("data-finance-row") !== "income:credit-purchases" &&
            r.getAttribute("data-finance-row") !== "income:node-services"
        )
        .map((r) => r.querySelectorAll("td")[2]?.textContent?.trim());
    expect(costs()[0]).toBe("$0.38/day");
    expect(costs().slice(-1)).toEqual(["—"]);
    fireEvent.click(sort);
    expect(costs()[0]).toBe("$9.72/day");
    expect(costs().slice(-1)).toEqual(["—"]);
  });
  it("announces refresh failure without losing current evidence", async () => {
    access.refresh.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    render(<FinanceReportClient report={liveShapedFinancePreview} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh", exact: true })
    );
    expect(
      await screen.findByText(/Refresh failed. Try again./)
    ).toBeInTheDocument();
    expect(cells(1)).toContain("$74.52");
  });
  it("renders only the package report on the page; finance.server is the single read path", async () => {
    access.allowed = true;
    access.readers.mockResolvedValueOnce({
      readers: [],
      treasuryPlane: null,
      stewardWalletUrl: null,
    });
    render(await FinancePage());
    expect(
      screen.getByRole("heading", { level: 1, name: "Financials" })
    ).toBeInTheDocument();
    expect(screen.queryByText(/Provider funding/i)).not.toBeInTheDocument();
  });
  it("isolates fixture treasury from the outer cache and never requests live finance after staleness or invalidation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const outer = new QueryClient();
    outer.setQueryData(["treasury", "snapshot"], {
      balances: [{ balanceFormatted: "999" }],
    });
    let inner: QueryClient | undefined;
    function Probe() {
      inner = useQueryClient();
      const snapshot = useTreasurySnapshot();
      return <span>{snapshot.usdcBalance ?? "Unavailable"}</span>;
    }
    const { rerender } = render(
      <QueryClientProvider client={outer}>
        <FixtureQueryBoundary key="known" report={liveShapedFinancePreview}>
          <Probe />
        </FixtureQueryBoundary>
      </QueryClientProvider>
    );
    expect(screen.getByText("74.52")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121000);
      await inner?.invalidateQueries({ queryKey: ["treasury", "snapshot"] });
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).not.toHaveBeenCalled();
    rerender(
      <QueryClientProvider client={outer}>
        <FixtureQueryBoundary key="missing" report={sparseFinancePreview}>
          <Probe />
        </FixtureQueryBoundary>
      </QueryClientProvider>
    );
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["production", "test"])("preview returns 404 in %s", (env) => {
    vi.stubEnv("NODE_ENV", env);
    expect(() => FinancePreviewPage()).toThrow("NEXT_NOT_FOUND");
  });
  it("previews the page with demo data, including the fund-steward row action", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(FinancePreviewPage());
    expect(screen.getByText(/Demo data · live-shaped/)).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Fund steward" }).length
    ).toBeGreaterThan(0);
  });
  it("a row with a payer other than this node shows a payer subline", () => {
    const first = liveShapedFinancePreview.rows[0];
    if (!first) throw new Error("Missing fixture");
    const guest: MoneyPlaneRow = {
      ...first,
      plane: "guest",
      label: "Guest line",
      payer: "Poly DAO",
    };
    const report: FinanceReportModel = {
      ...liveShapedFinancePreview,
      rows: [...liveShapedFinancePreview.rows, guest],
    };
    render(<FinanceReportClient report={report} />);
    expect(grid().getByText("Paid by Poly DAO")).toBeVisible();
  });
});
