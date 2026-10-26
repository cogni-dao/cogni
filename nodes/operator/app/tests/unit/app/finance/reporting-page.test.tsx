// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `reporting-page.test`
 * Purpose: Prove the five-column Financials table, risk ordering, the Source dialog, the restored funding rail and access guards.
 * Scope: Actual ReUI/TanStack rendering with no live providers or app shell IO.
 * Invariants: Unknown is a dash with a reason behind Source; no status pills; funding actions stay reachable.
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
  readers: vi.fn(async () => ({ readers: [], treasuryPlane: null })),
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
  restoreCostLineGrades: (rows: unknown[]) => rows,
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
vi.mock("@/app/(admin)/admin/payments/funding.server", () => ({
  getAiFunding: async () => ({
    openRouterRemainingUsd: 3.1,
    cherryRemaining: 12.4,
    cherryCurrency: "EUR",
    operatorWalletUsdc: 10.77,
    stewardWalletUsdc: 7.07,
    operatorWalletAddress: "0x2222222222222222222222222222222222222222",
    stewardWalletAddress: "0x3333333333333333333333333333333333333333",
  }),
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
  const dialog = await import("@cogni/node-ui-kit/shadcn/dialog");
  const select = await import("@cogni/node-ui-kit/shadcn/select");
  const card = await import("@cogni/node-ui-kit/shadcn/card");
  const separator = await import("@cogni/node-ui-kit/shadcn/separator");
  const text = await import("@/components/kit/typography/ReportText");
  const button = await import("@/components/kit/inputs/Button");
  const input = await import("@/components/kit/inputs/Input");
  const hint = await import("@/components/kit/feedback/HintText");
  return {
    ...grid,
    ...header,
    ...table,
    ...dialog,
    ...select,
    ...card,
    ...separator,
    ...text,
    ...button,
    ...input,
    ...hint,
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
} from "@/app/dev/finance-preview/fixture";
import { FixtureQueryBoundary } from "@/app/dev/finance-preview/Preview.client";
import FinancePreviewPage from "@/app/dev/finance-preview/page";
import { FinanceReport } from "@/features/finance/components/FinanceReport";
import {
  burnLabel,
  fleetBurnPerDay,
  runwayLabel,
} from "@/features/finance/components/format";
import { useTreasurySnapshot } from "@/features/treasury/hooks/useTreasurySnapshot";

function grid() {
  return within(screen.getByRole("region", { name: "Financials table" }));
}
function headers(): string[] {
  return Array.from(screen.getByRole("table").querySelectorAll("thead th")).map(
    (th) => th.textContent?.trim() ?? ""
  );
}
function lines(): string[] {
  return Array.from(screen.getByRole("table").querySelectorAll("tbody tr")).map(
    (row) => row.querySelector("td p")?.textContent ?? ""
  );
}
function cells(column: number): string[] {
  return Array.from(screen.getByRole("table").querySelectorAll("tbody tr")).map(
    (row) => row.querySelectorAll("td")[column]?.textContent?.trim() ?? ""
  );
}
const graded = (
  grade: MoneyPlaneRow["grade"],
  label: string,
  runwayDays: number
): MoneyPlaneRow => ({
  plane: `demo:${label}`,
  label,
  kind: "prepaid",
  balance: 10,
  currency: "USD",
  burnPerDay: 10 / runwayDays,
  runwayDays,
  grade,
  observedAt: liveShapedFinancePreview.takenAt,
  sourceObservedAt: liveShapedFinancePreview.takenAt,
  freshness: "current",
  source: "Demo",
});

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
  it("emits only coverage after an authorized read", async () => {
    access.allowed = true;
    await expect(getFinanceReport()).resolves.toMatchObject({
      rows: [],
      treasuryPlane: null,
    });
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
  it("renders one five-column table with the treasury and fleet burn in the header", () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    expect(screen.getByRole("heading", { name: "Financials" })).toBeVisible();
    expect(headers()).toEqual([
      "Line",
      "Balance",
      "Burn/day",
      "Runway",
      "Source",
    ]);
    expect(
      screen.getByText(
        "Treasury 74.52 USDC · Fleet burn $12.85 / day ($89.93 / week) + €0.34 / day"
      )
    ).toBeVisible();
    expect(cells(1)).toContain("74.52 USDC");
    expect(cells(1)).toContain("€12.40");
    expect(cells(1)).toContain("$3.10");
    expect(cells(1)).toContain("$7.89");
    expect(cells(2)).toContain("$1.57 / day");
    expect(cells(2)).toContain("$0.19 / day");
    expect(cells(3)[0]).toBe("2 d");
    expect(fleetBurnPerDay(liveShapedFinancePreview.rows)).toBeCloseTo(
      3.13 + 252.65 / 26,
      9
    );
    expect(lines()).toHaveLength(17);
    expect(screen.queryByText(/not yet reported/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot=badge]")).toBeNull();
    expect(screen.queryByText(/Other accounts/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Known contract rate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/ block/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Payment history is not included in this report.")
    ).toBeVisible();
  });
  it("orders rows RED, YELLOW, then measured GREEN/INFO, then unmeasured, placeholders last, and colors runway", () => {
    render(
      <FinanceReport
        report={{
          ...liveShapedFinancePreview,
          rows: [
            ...liveShapedFinancePreview.rows,
            graded("GREEN", "Fine credit", 90),
            graded("RED", "Dying credit", 3),
            graded("YELLOW", "Watch credit", 14),
          ],
        }}
      />
    );
    expect(lines()).toEqual([
      "Akash credit · fleet",
      "Dying credit",
      "Watch credit",
      "Cherry compute credit",
      "Domain renewal · cognidao.org",
      "Fine credit",
      "Akash hosting · beacon",
      "Akash hosting · levelup",
      "Akash hosting · node-template",
      "Akash hosting · poly",
      "Akash hosting · red",
      "Akash hosting · toks5",
      "DAO treasury",
      "Grafana Cloud · overage this month",
      "Operator wallet · working capital",
      "Steward wallet · human custody",
      "OpenRouter credit",
      "Base RPC (Alchemy)",
      "Other SaaS · PostHog, Langfuse, Tavily, GitHub, DoltHub, SonarCloud, Privy",
      "System tenant · internal credits",
    ]);
    expect(cells(3).slice(0, 6)).toEqual([
      "2 d",
      "3 d",
      "14 d",
      "36 d",
      "161 d",
      "90 d",
    ]);
    expect(cells(3)[6]).toBe("—");
    const red = grid().getByText("3 d");
    expect(red.className).toContain("text-destructive");
    expect(red.className).not.toContain("text-foreground");
    expect(grid().getByText("14 d").className).toContain("text-warning");
    expect(grid().getByText("90 d").className).toContain("text-success");
    expect(grid().getByText("Paid by Operator · for poly")).toBeVisible();
  });
  it("sorts a numeric column both ways and keeps unmeasured last", () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    const sort = grid().getByRole("button", { name: "Burn/day", exact: true });
    fireEvent.click(sort);
    expect(cells(2)[0]).toBe("$0.19 / day");
    expect(cells(2).slice(-1)).toEqual(["—"]);
    fireEvent.click(sort);
    expect(cells(2)[0]).toBe("$9.72 / day");
    expect(cells(2).slice(-1)).toEqual(["—"]);
  });
  it("drops all-dash numeric columns in the sparse scenario, names them once, and explains rows behind Source", async () => {
    render(<FinanceReport report={sparseFinancePreview} />);
    expect(screen.queryByText(/Treasury/)).not.toBeInTheDocument();
    expect(headers()).toEqual(["Line", "Balance", "Source"]);
    expect(new Set(cells(1))).toEqual(new Set(["—"]));
    expect(
      screen.getByText("Burn and runway are not yet reported.")
    ).toBeVisible();
    expect(lines().slice(-1)).toEqual(["System tenant · internal credits"]);
    expect(lines()).toHaveLength(12);
    await userEvent.click(
      grid().getByRole("button", { name: "Akash credit · fleet source" })
    );
    expect(
      within(screen.getByRole("dialog")).getByText(/Akash chain read failed/)
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      grid().getByRole("button", { name: "DAO treasury source" })
    );
    let dialog = screen.getByRole("dialog", { name: "DAO treasury" });
    expect(within(dialog).getByText(/RPC unavailable/)).toBeVisible();
    expect(within(dialog).queryByText("unreadable")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      grid().getByRole("button", { name: "OpenRouter credit source" })
    );
    dialog = screen.getByRole("dialog", { name: "OpenRouter credit" });
    expect(within(dialog).getByText(/no OpenRouter key/)).toBeVisible();
  });
  it("opens exact native evidence, basis and cadence in one dialog, closes with Escape and restores focus", async () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    const source = grid().getByRole("button", {
      name: "Akash hosting · poly source",
    });
    source.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", {
      name: "Akash hosting · poly",
    });
    expect(
      within(dialog).getByText(
        "On-chain lease price · 5.884 s/block · Contract rate · per block"
      )
    ).toBeVisible();
    expect(within(dialog).getByText("106.92 uact / block")).toBeVisible();
    expect(within(dialog).getByText("1.57 USD")).toBeVisible();
    expect(
      within(dialog).getByText("4.21 USD credit (4,210,000 uact)")
    ).toBeVisible();
    expect(within(dialog).getByText(/Source time unknown/)).toBeVisible();
    expect(
      within(dialog).getByText("Paid by Operator · for poly")
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(source).toHaveFocus();
  });
  it("shows Console credit and escrow separately with the block cadence for the Akash credit row", async () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    await userEvent.click(
      grid().getByRole("button", { name: "Akash credit · fleet source" })
    );
    const dialog = screen.getByRole("dialog", { name: "Akash credit · fleet" });
    expect(within(dialog).getByText(/5\.884 s\/block/)).toBeVisible();
    expect(within(dialog).getByText(/balance ÷ burn per day/)).toBeVisible();
    expect(
      within(dialog).getByText("5.79 USD credit (5,790,000 uact)")
    ).toBeVisible();
    expect(
      within(dialog).getByText("2.10 USD credit (2,100,000 uact)")
    ).toBeVisible();
    expect(within(dialog).getByText("Paid by Operator")).toBeVisible();
  });
  it("keeps a known-zero column but omits a column no row can fill", () => {
    const rows = liveShapedFinancePreview.rows.map((row) => ({
      ...row,
      runwayDays: null,
      grade:
        row.grade === "RED" || row.grade === "GREEN"
          ? ("UNKNOWN" as const)
          : row.grade,
    }));
    const { rerender } = render(
      <FinanceReport report={{ ...liveShapedFinancePreview, rows }} />
    );
    expect(headers()).toEqual(["Line", "Balance", "Burn/day", "Source"]);
    expect(screen.getByText("Runway is not yet reported.")).toBeVisible();
    rerender(
      <FinanceReport
        report={{
          ...liveShapedFinancePreview,
          rows: rows.map((row) => ({ ...row, burnPerDay: 0 })),
        }}
      />
    );
    expect(headers()).toEqual(["Line", "Balance", "Burn/day", "Source"]);
    expect(cells(2).every((cell) => /0\.00 .*\/ day$/.test(cell))).toBe(true);
    expect(cells(2)).toContain("$0.00 / day");
  });
  it("explains an unmeasured runway on a known credit balance", async () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    await userEvent.click(
      grid().getByRole("button", { name: "OpenRouter credit source" })
    );
    const dialog = screen.getByRole("dialog", { name: "OpenRouter credit" });
    expect(within(dialog).getByText(/burn not measured/)).toBeVisible();
    expect(within(dialog).getByText("3.1 USD")).toBeVisible();
    expect(within(dialog).getByText(/2026/)).toBeVisible();
  });
  it("announces refresh failure without losing current evidence", () => {
    access.refresh.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    render(<FinanceReport report={liveShapedFinancePreview} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh", exact: true })
    );
    expect(screen.getByText(/Refresh failed. Try again./)).toBeInTheDocument();
    expect(cells(1)).toContain("74.52 USDC");
  });
  it("renders the report first and the restored Provider Funding rail with every action", async () => {
    access.allowed = true;
    access.readers.mockResolvedValueOnce({
      readers: [],
      treasuryPlane: null,
    });
    render(await FinancePage());
    const h1 = screen.getByRole("heading", { level: 1, name: "Financials" });
    const h2 = screen.getByRole("heading", {
      level: 2,
      name: "Provider funding",
    });
    expect(
      h1.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Fund steward/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Top up OpenRouter/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Top up Cherry/ })
    ).toBeInTheDocument();
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
  it("previews the whole page: demo report plus the Provider funding rail", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(FinancePreviewPage());
    expect(screen.getByText(/Demo data · live-shaped/)).toBeVisible();
    expect(
      screen.getByRole("heading", { level: 2, name: "Provider funding" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Fund steward/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Top up Cherry/ })
    ).toBeInTheDocument();
  });
  it("never rounds a tiny positive burn to zero and never grades an INFO runway", () => {
    const row = liveShapedFinancePreview.rows.find(
      (candidate) => candidate.plane === "akash:poly"
    );
    if (!row) throw new Error("Missing fixture");
    expect(burnLabel({ ...row, burnPerDay: 0.001 })).toBe("<$0.01 / day");
    expect(runwayLabel({ ...row, runwayDays: 12 })).toBe("—");
    expect(runwayLabel({ ...row, grade: "GREEN", runwayDays: 12.9 })).toBe(
      "12 d"
    );
    expect(runwayLabel({ ...row, grade: "RED", runwayDays: 0.4 })).toBe("<1 d");
  });
});
