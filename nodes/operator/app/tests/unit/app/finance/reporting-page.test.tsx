// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `reporting-page.test`
 * Purpose: Prove the five-column Financials table (Line · Balance · Burn/day · Runway · Action), risk ordering, the Line dialog, row actions incl. the fund-steward POST, and access guards.
 * Scope: Actual ReUI/TanStack rendering with no live providers or app shell IO.
 * Invariants: Unknown is a dash with a reason behind the Line dialog; no status pills; the table is the page.
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
  const text = await import("@/components/kit/typography/ReportText");
  const button = await import("@/components/kit/inputs/Button");
  const input = await import("@/components/kit/inputs/Input");
  return {
    ...grid,
    ...header,
    ...table,
    ...dialog,
    ...select,
    ...card,
    ...text,
    ...button,
    ...input,
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
  refreshedLabel,
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
function bodyRows(): HTMLElement[] {
  return Array.from(
    screen.getByRole("table").querySelectorAll<HTMLElement>("tbody tr")
  );
}
function lines(): string[] {
  return bodyRows().map(
    (row) => row.querySelector("td button")?.getAttribute("aria-label") ?? ""
  );
}
function cells(column: number): string[] {
  return bodyRows().map(
    (row) => row.querySelectorAll("td")[column]?.textContent?.trim() ?? ""
  );
}
function rowOf(label: string): HTMLElement {
  const row = bodyRows().find(
    (r) => r.querySelector("td button")?.getAttribute("aria-label") === label
  );
  if (!row) throw new Error(`Missing row ${label}`);
  return row;
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
  it("renders one five-column table; the table is the page", () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    expect(screen.getByRole("heading", { name: "Financials" })).toBeVisible();
    expect(screen.getByText(/^Refreshed /)).toBeVisible();
    expect(headers()).toEqual([
      "Line",
      "Balance",
      "Burn/day",
      "Runway",
      "Action",
    ]);
    expect(
      screen.getByText("Treasury 74.52 USDC · Burn $12.85/day · €0.34/day")
    ).toBeVisible();
    expect(fleetBurnPerDay(liveShapedFinancePreview.rows)).toBeCloseTo(
      3.13 + 252.65 / 26,
      9
    );
    expect(lines()).toHaveLength(17);
    expect(cells(1)).toContain("74.52 USDC");
    expect(cells(1)).toContain("€12.40");
    expect(cells(1)).toContain("$7.89");
    expect(cells(2)).toContain("$1.57/day");
    expect(cells(2)).toContain("€0.34/day");
    expect(cells(3)[0]).toBe("2d");
    expect(document.querySelector("[data-slot=badge]")).toBeNull();
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
    expect(screen.queryByText(/Paid by Operator/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Payment history/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not yet reported/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider funding/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/ block/)).not.toBeInTheDocument();
  });
  it("shows a payer subline only when the payer is not this node", () => {
    render(
      <FinanceReport
        report={{
          ...liveShapedFinancePreview,
          rows: [
            ...liveShapedFinancePreview.rows,
            { ...graded("GREEN", "Guest line", 50), payer: "Poly DAO" },
          ],
        }}
      />
    );
    expect(grid().getByText("Paid by Poly DAO")).toBeVisible();
    expect(grid().queryByText(/Paid by Operator/)).not.toBeInTheDocument();
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
      "Akash credit",
      "Dying credit",
      "Watch credit",
      "Cherry credit",
      "Domain cognidao.org",
      "Fine credit",
      "Akash · beacon",
      "Akash · levelup",
      "Akash · node-template",
      "Akash · poly",
      "Akash · red",
      "Akash · toks5",
      "DAO treasury",
      "Grafana overage",
      "Operator wallet",
      "Steward wallet",
      "OpenRouter credit",
      "Alchemy RPC",
      "Other SaaS",
      "System tenant",
    ]);
    expect(cells(3).slice(0, 6)).toEqual([
      "2d",
      "3d",
      "14d",
      "36d",
      "161d",
      "90d",
    ]);
    expect(cells(3)[6]).toBe("—");
    const red = grid().getByText("3d");
    expect(red.className).toContain("text-destructive");
    expect(red.className).not.toContain("text-foreground");
    expect(grid().getByText("14d").className).toContain("text-warning");
    expect(grid().getByText("90d").className).toContain("text-success");
  });
  it("sorts a numeric column both ways and keeps unmeasured last", () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    const sort = grid().getByRole("button", { name: "Burn/day", exact: true });
    fireEvent.click(sort);
    expect(cells(2)[0]).toBe("$0.19/day");
    expect(cells(2).slice(-1)).toEqual(["—"]);
    fireEvent.click(sort);
    expect(cells(2)[0]).toBe("$9.72/day");
    expect(cells(2).slice(-1)).toEqual(["—"]);
  });
  it("drops all-dash numeric columns in the sparse scenario and explains rows behind the Line dialog", async () => {
    render(<FinanceReport report={sparseFinancePreview} />);
    expect(screen.queryByText(/Treasury/)).not.toBeInTheDocument();
    expect(headers()).toEqual(["Line", "Balance", "Action"]);
    expect(new Set(cells(1))).toEqual(new Set(["—"]));
    expect(screen.queryByText(/not yet reported/)).not.toBeInTheDocument();
    expect(lines().slice(-1)).toEqual(["System tenant"]);
    expect(lines()).toHaveLength(12);
    await userEvent.click(grid().getByRole("button", { name: "DAO treasury" }));
    let dialog = screen.getByRole("dialog", { name: "DAO treasury" });
    expect(within(dialog).getByText(/RPC unavailable/)).toBeVisible();
    expect(within(dialog).queryByText("unreadable")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      grid().getByRole("button", { name: "OpenRouter credit" })
    );
    dialog = screen.getByRole("dialog", { name: "OpenRouter credit" });
    expect(within(dialog).getByText(/no OpenRouter key/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(grid().getByRole("button", { name: "Akash credit" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/Akash chain read failed/)
    ).toBeVisible();
  });
  it("opens exact native evidence from the Line label, closes with Escape and restores focus", async () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    const trigger = grid().getByRole("button", { name: "Akash · poly" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Akash · poly" });
    expect(
      within(dialog).getByText(
        "On-chain lease price · 5.884 s/block · contract rate / block"
      )
    ).toBeVisible();
    expect(within(dialog).getByText("106.92 uact / block")).toBeVisible();
    expect(
      within(dialog).getByText("4.21 USD credit (4,210,000 uact)")
    ).toBeVisible();
    expect(within(dialog).getByText(/Source time unknown/)).toBeVisible();
    expect(within(dialog).getByText("Operator · for poly")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("shows Console credit and escrow separately with the block cadence for the Akash credit row", async () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    await userEvent.click(grid().getByRole("button", { name: "Akash credit" }));
    const dialog = screen.getByRole("dialog", { name: "Akash credit" });
    expect(within(dialog).getByText(/5\.884 s\/block/)).toBeVisible();
    expect(within(dialog).getByText(/balance ÷ burn/)).toBeVisible();
    expect(
      within(dialog).getByText("5.79 USD credit (5,790,000 uact)")
    ).toBeVisible();
    expect(
      within(dialog).getByText("2.10 USD credit (2,100,000 uact)")
    ).toBeVisible();
  });
  it("moves the money-chain explanation into the Operator wallet dialog and lists Other SaaS vendors only there", async () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    expect(screen.queryByText(/PostHog/)).not.toBeInTheDocument();
    await userEvent.click(
      grid().getByRole("button", { name: "Operator wallet" })
    );
    expect(
      within(screen.getByRole("dialog")).getByText(
        "User payments → operator wallet → steward wallet → vendors"
      )
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(grid().getByRole("button", { name: "Other SaaS" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/PostHog, Langfuse/)
    ).toBeVisible();
  });
  it("renders row actions from payAction: fund-steward control, Top up links, empty cell otherwise", () => {
    render(<FinanceReport report={liveShapedFinancePreview} />);
    const operator = rowOf("Operator wallet");
    expect(
      within(operator).getByRole("button", { name: "Fund steward" })
    ).toBeVisible();
    expect(
      within(operator).getByRole("spinbutton", { name: "Fund steward (USD)" })
    ).toHaveValue(1);
    expect(
      within(rowOf("OpenRouter credit")).getByRole("link", { name: /Top up/ })
    ).toHaveAttribute("href", "https://openrouter.ai/settings/credits");
    expect(
      within(rowOf("Cherry credit")).getByRole("link", { name: /Top up/ })
    ).toHaveAttribute("href", "https://portal.cherryservers.com/");
    expect(
      within(rowOf("Akash credit")).getByRole("link", { name: /Top up/ })
    ).toHaveAttribute("href", "https://console.akash.network/");
    const treasury = rowOf("DAO treasury");
    expect(treasury.querySelectorAll("td")[4]?.textContent).toBe("");
    expect(within(treasury).queryByRole("link")).not.toBeInTheDocument();
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
    render(<FinanceReport report={liveShapedFinancePreview} />);
    const operator = rowOf("Operator wallet");
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
    expect(headers()).toEqual(["Line", "Balance", "Burn/day", "Action"]);
    rerender(
      <FinanceReport
        report={{
          ...liveShapedFinancePreview,
          rows: rows.map((row) => ({ ...row, burnPerDay: 0 })),
        }}
      />
    );
    expect(headers()).toEqual(["Line", "Balance", "Burn/day", "Action"]);
    expect(cells(2).every((cell) => /0\.00 ?[A-Z]*\/day$/.test(cell))).toBe(
      true
    );
    expect(cells(2)).toContain("$0.00/day");
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
  it("renders only the report on the page: no funding panel, finance.server is the single read path", async () => {
    access.allowed = true;
    access.readers.mockResolvedValueOnce({ readers: [], treasuryPlane: null });
    render(await FinancePage());
    expect(
      screen.getByRole("heading", { level: 1, name: "Financials" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
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
    expect(screen.queryByText(/Provider funding/i)).not.toBeInTheDocument();
  });
  it("formats burn, runway and the refreshed time compactly", () => {
    const row = liveShapedFinancePreview.rows.find(
      (candidate) => candidate.plane === "akash:poly"
    );
    if (!row) throw new Error("Missing fixture");
    expect(burnLabel({ ...row, burnPerDay: 0.001 })).toBe("<$0.01/day");
    expect(runwayLabel({ ...row, runwayDays: 12 })).toBe("—");
    expect(runwayLabel({ ...row, grade: "GREEN", runwayDays: 12.9 })).toBe(
      "12d"
    );
    expect(runwayLabel({ ...row, grade: "RED", runwayDays: 0.4 })).toBe("<1d");
    const at = "2026-10-26T13:40:00.000Z";
    expect(refreshedLabel(at, "UTC", new Date("2026-10-26T20:00:00Z"))).toBe(
      "1:40 PM"
    );
    expect(refreshedLabel(at, "UTC", new Date("2026-10-27T01:00:00Z"))).toBe(
      "Oct 26, 1:40 PM"
    );
  });
});
