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
    readers: [],
    treasuryPlane: null,
    configuredWalletPlanes: [],
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
  const dialog = await import("@cogni/node-ui-kit/shadcn/dialog");
  const select = await import("@cogni/node-ui-kit/shadcn/select");
  const card = await import("@cogni/node-ui-kit/shadcn/card");
  const text = await import("@/components/kit/typography/ReportText");
  const button = await import("@/components/kit/inputs/Button");
  const badge = await import("@/components/kit/data-display/Badge");
  return {
    ...grid,
    ...header,
    ...table,
    ...dialog,
    ...select,
    ...card,
    ...text,
    ...button,
    ...badge,
    PageContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { getFinanceReport } from "@/app/(admin)/admin/payments/finance.server";
import {
  financePreview,
  missingFinancePreview,
  richFinancePreview,
} from "@/app/dev/finance-preview/fixture";
import { FixtureQueryBoundary } from "@/app/dev/finance-preview/Preview.client";
import FinancePreviewPage from "@/app/dev/finance-preview/page";
import { FinanceReport } from "@/features/finance/components/FinanceReport";
import { amountLabel } from "@/features/finance/components/format";
import { useTreasurySnapshot } from "@/features/treasury/hooks/useTreasurySnapshot";

function services(): string[] {
  return Array.from(screen.getByRole("table").querySelectorAll("tbody tr")).map(
    (row) => row.querySelector("td p")?.textContent ?? ""
  );
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
  it("emits only coverage after an authorized read", async () => {
    access.allowed = true;
    await expect(getFinanceReport()).resolves.toMatchObject({
      rows: [],
      configuredWalletPlanes: [],
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
  it("shows configured treasury, suppresses absent numeric columns and hides absent optional custody", () => {
    render(<FinanceReport report={financePreview} />);
    expect(screen.getByRole("heading", { name: "Financials" })).toBeVisible();
    expect(screen.getByText("10 USDC")).toBeVisible();
    expect(services()).not.toContain("DAO treasury");
    expect(screen.queryByText("Steward custody")).not.toBeInTheDocument();
    expect(screen.getByText("Operator working capital")).toBeVisible();
    expect(screen.getByText("Balance unavailable")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Balance / credit", exact: true })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Runway", exact: true })
    ).not.toBeInTheDocument();
    expect(screen.getByText("0.000005 USD credit / block")).toBeVisible();
    expect(
      screen.getByText(/Partial coverage · Last known · age unknown/)
    ).toBeVisible();
    expect(document.querySelector("details")).toBeNull();
  });
  it("never substitutes custody for a missing treasury", () => {
    render(<FinanceReport report={missingFinancePreview} />);
    expect(screen.getByText("Treasury not identified")).toBeVisible();
    expect(screen.getByText("Operator-funded")).toBeVisible();
  });
  it.each([
    "Balance / credit",
    "Runway",
    "Rate",
  ])("sorts %s both ways and keeps missing last", (title) => {
    render(<FinanceReport report={richFinancePreview} />);
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
  it("resets a removed numeric sort and keeps a real zero column", () => {
    const { rerender } = render(<FinanceReport report={richFinancePreview} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Runway", exact: true })
    );
    rerender(<FinanceReport report={financePreview} />);
    expect(
      screen.getByText("Sorted by Status, ascending.")
    ).toBeInTheDocument();
    const source = financePreview.rows.find(
      (row) => row.label === "OpenRouter"
    );
    if (!source) throw new Error("Missing fixture");
    rerender(
      <FinanceReport
        report={{
          ...financePreview,
          rows: [{ ...source, balance: 0, currency: "USD" }],
        }}
      />
    );
    expect(
      screen.getByRole("button", { name: "Balance / credit", exact: true })
    ).toBeInTheDocument();
  });
  it("opens exact evidence in one accessible dialog, closes with Escape and restores focus", async () => {
    render(<FinanceReport report={financePreview} />);
    const source = within(
      screen.getByRole("region", { name: "Services table" })
    ).getByRole("button", { name: "Akash hosting source — node-template" });
    source.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Akash hosting source" });
    expect(within(dialog).getByText("1250000 uact")).toBeVisible();
    expect(within(dialog).getByText("2 uact / block")).toBeVisible();
    expect(within(dialog).getByText(/1,000,000 uact = 1 ACT/)).toBeVisible();
    expect(
      within(dialog).queryByText("Missing evidence")
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("unconfigured")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(source).toHaveFocus();
  });
  it("discloses supplied precision and separate read/source time without raw schema fields", async () => {
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
              sourceObservedAt: "2026-10-24T12:00:00.123Z",
              observedAt: "2026-10-24T12:05:00.456Z",
            },
          ],
        }}
      />
    );
    await userEvent.click(
      within(screen.getByRole("region", { name: "Services table" })).getByRole(
        "button",
        { name: /OpenRouter source/ }
      )
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("1.23456789 USD")).toBeVisible();
    expect(within(dialog).getByText("1e-8 USD / day")).toBeVisible();
    expect(within(dialog).getByText(/12:00:00.123 UTC/)).toBeVisible();
    expect(within(dialog).queryByText("Report read")).not.toBeInTheDocument();
  });
  it("announces refresh failure without losing current evidence", () => {
    access.refresh.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    render(<FinanceReport report={financePreview} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh", exact: true })
    );
    expect(screen.getByText(/Refresh failed. Try again./)).toBeInTheDocument();
    expect(screen.getByText("10 USDC")).toBeVisible();
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
        <FixtureQueryBoundary key="known" report={financePreview}>
          <Probe />
        </FixtureQueryBoundary>
      </QueryClientProvider>
    );
    expect(screen.getByText("10")).toBeInTheDocument();
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
        <FixtureQueryBoundary key="missing" report={missingFinancePreview}>
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
  it("labels the actual source-shaped renderer as fixture data", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(FinancePreviewPage());
    expect(screen.getByText(/Demo data · source-shaped/)).toBeVisible();
  });
  it("does not round tiny positive credit to zero", () => {
    expect(amountLabel({ amount: "0.00001", currency: "uact" })).toBe(
      "<0.000001 USD compute credit"
    );
  });
});
