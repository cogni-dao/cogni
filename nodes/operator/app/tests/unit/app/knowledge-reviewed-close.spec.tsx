// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-reviewed-close`
 * Purpose: Prove reviewed selection, explicit serial writes and authoritative recovery.
 * Scope: Real panel/fetch helpers with simulated HTTP, not native database proof.
 * Invariants: NO_WRITE_ON_GET, EXACT_REVIEWED_HEAD, RECONCILE_EVERY_ATTEMPT.
 * Side-effects: global (stubbed fetch)
 * @vitest-environment jsdom
 * @internal
 */

import type { ContributionRecord } from "@cogni/node-contracts";
import { ContributionCloseRequestSchema } from "@cogni/node-contracts";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
} from "@testing-library/react";
import { NextRequest } from "next/server";
import pino from "pino";
import type { ButtonHTMLAttributes, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeContribution,
  ReviewedCloseError,
} from "@/app/(app)/knowledge/_api/closeContribution";
import { fetchContributions } from "@/app/(app)/knowledge/_api/fetchContributions";
import { parseReviewedClose } from "@/app/(app)/knowledge/_api/reviewedClose";
import { ReviewedClosePanel } from "@/app/(app)/knowledge/_components/ReviewedClosePanel";
import { handleClose } from "@/app/api/v1/knowledge/contributions/_handlers";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http/wrapRouteHandlerWithLogging";
import { EVENT_NAMES } from "@/shared/observability";

vi.mock("@/components", () => ({
  Button: ({
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

const routeClose = vi.hoisted(() => vi.fn());
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ knowledgeContributionService: { close: routeClose } }),
}));
vi.mock("@/bootstrap/node-admin-gate", () => ({
  checkNodeAdmin: vi.fn(),
  isGoalRowId: vi.fn(),
  nodeAdminFailureBody: vi.fn(),
}));
vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeId: () => "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attributes: unknown,
    run: (ctx: {
      traceId: string;
      span: { setAttribute: ReturnType<typeof vi.fn> };
    }) => Promise<unknown>
  ) => run({ traceId: "test-trace", span: { setAttribute: vi.fn() } }),
}));
vi.mock("@/shared/observability", async () => ({
  ...(await vi.importActual<typeof import("@cogni/node-shared")>(
    "@cogni/node-shared"
  )),
  statusBucket: (status: number) => `${Math.floor(status / 100)}xx`,
  httpRequestsTotal: { inc: vi.fn() },
  httpRequestDurationMs: { observe: vi.fn() },
}));

function render(
  ui: ReactElement,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
) {
  return renderUi(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

function CachedInboxSummary() {
  const query = useQuery({
    queryKey: ["knowledge", "contributions", "open"],
    queryFn: () => fetchContributions("open"),
    staleTime: 15_000,
  });
  return (
    <aside>
      <output data-testid="inbox-count">
        {query.data?.contributions.length}
      </output>
      <ul data-testid="inbox-table">
        {query.data?.contributions.map((item) => (
          <li key={item.contributionId}>{item.message}</li>
        ))}
      </ul>
    </aside>
  );
}

function record(
  id: string,
  head: string | null = "head-1",
  state: ContributionRecord["state"] = "open"
): ContributionRecord {
  return {
    contributionId: id,
    headCommit: head,
    state,
    message: `Proposal ${id}`,
    branch: `contrib/${id}`,
    baseCommit: "base",
    commitCount: head === null ? 0 : 1,
    principalId: "author",
    principalKind: "agent",
    mergedCommit: null,
    closedReason: null,
    idempotencyKey: null,
    createdAt: "2026-10-27T00:00:00Z",
    resolvedAt: null,
    resolvedBy: null,
  };
}
function link(
  items: { contributionId: string; expectedHeadCommit: string | null }[]
) {
  return JSON.stringify({ reason: "Reviewed obsolete proposals", items });
}
function network(
  records: ContributionRecord[],
  post?: (id: string, body: unknown) => Promise<Response>
) {
  const current = new Map(records.map((item) => [item.contributionId, item]));
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const id = decodeURIComponent(url.split("/")[5] ?? "");
    const method = options?.method ?? "GET";
    calls.push(`${method} ${id}`);
    if (
      method === "GET" &&
      url.startsWith("/api/v1/knowledge/contributions?")
    ) {
      return Response.json({
        contributions: [...current.values()].filter(
          (item) => item.state === "open"
        ),
      });
    }
    if (method === "POST") {
      if (post) return post(id, JSON.parse(String(options?.body)));
      const item = current.get(id);
      if (item) current.set(id, { ...item, state: "closed" });
      return Response.json({ contributionId: id, closed: true });
    }
    const item = current.get(id);
    return item
      ? Response.json(item)
      : Response.json({ error: "missing" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { current, calls, fetchMock };
}
async function clickReady(count: number) {
  const button = await screen.findByRole("button", {
    name: `Close ${count} reviewed proposals`,
  });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false)
  );
  fireEvent.click(button);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reviewed close", () => {
  it("keeps explicit null and omitted API guards distinct", () => {
    expect(
      ContributionCloseRequestSchema.parse({
        reason: "reviewed",
        expectedHeadCommit: null,
      })
    ).toHaveProperty("expectedHeadCommit", null);
    expect(
      ContributionCloseRequestSchema.parse({ reason: "legacy" })
    ).not.toHaveProperty("expectedHeadCommit");
    expect(
      ContributionCloseRequestSchema.safeParse({
        reason: "bad",
        expectedHeadCommit: "",
      }).success
    ).toBe(false);
  });

  it("rejects duplicate, missing-head, unknown-field and oversized review data before reads", () => {
    const { fetchMock } = network([]);
    const item = { contributionId: "a", expectedHeadCommit: null };
    for (const value of [
      link([item, item]),
      JSON.stringify({ reason: "r", items: [{ contributionId: "a" }] }),
      JSON.stringify({ reason: "r", items: [item], extra: true }),
      "x".repeat(16_385),
    ]) {
      expect(() => parseReviewedClose(value)).toThrow();
    }
    render(<ReviewedClosePanel value="invalid" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Invalid review link"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews real titles, excludes changed/closed records and serially sends exact nullable guards only after click", async () => {
    const n = network([
      record("empty", null),
      record("stale", "new"),
      record("closed", "head-1", "closed"),
      record("current"),
    ]);
    render(
      <ReviewedClosePanel
        value={link([
          { contributionId: "empty", expectedHeadCommit: null },
          { contributionId: "stale", expectedHeadCommit: "old" },
          { contributionId: "closed", expectedHeadCommit: "head-1" },
          { contributionId: "current", expectedHeadCommit: "head-1" },
        ])}
      />
    );
    await screen.findByText("Proposal current");
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(
      await screen.findByText("Changed since review; excluded")
    ).toBeTruthy();
    expect(screen.getByText("Already closed; excluded")).toBeTruthy();
    await clickReady(2);
    await waitFor(() =>
      expect(screen.getAllByText("Verified closed")).toHaveLength(2)
    );
    expect(n.calls.slice(4, 8)).toEqual([
      "POST empty",
      "GET empty",
      "POST current",
      "GET current",
    ]);
    const writes = n.fetchMock.mock.calls.filter(
      ([, opts]) => opts?.method === "POST"
    );
    expect(
      writes.map(
        ([, opts]) => JSON.parse(String(opts?.body)).expectedHeadCommit
      )
    ).toEqual([null, "head-1"]);
    expect(
      writes.every(([, opts]) => opts?.credentials === "same-origin")
    ).toBe(true);
  });

  it.each([
    "success-open",
    "network-open",
    "unknown409",
    "unauthorized",
  ])("stops on %s and leaves later rows unattempted", async (mode) => {
    const n = network([record("a"), record("b")], async () => {
      if (mode === "network-open") throw new TypeError("connection lost");
      if (mode === "unknown409")
        return Response.json(
          { error: "Uncertain", errorCode: "knowledge_write_outcome_unknown" },
          { status: 409 }
        );
      return Response.json(
        { error: "Session required" },
        { status: mode === "unauthorized" ? 401 : 200 }
      );
    });
    render(
      <ReviewedClosePanel
        value={link([
          { contributionId: "a", expectedHeadCommit: "head-1" },
          { contributionId: "b", expectedHeadCommit: "head-1" },
        ])}
      />
    );
    await clickReady(2);
    await screen.findByText(
      mode === "unknown409"
        ? "Uncertain"
        : mode === "unauthorized"
          ? "Session required"
          : "Close outcome is unresolved. Reload before trying again."
    );
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST a",
    ]);
    expect(n.calls).toContain("GET a");
    expect(screen.getByText("Not attempted")).toBeTruthy();
  });

  it("reconciles a lost acknowledgement to closed without replay", async () => {
    const n = network([record("a")], async () => {
      n.current.set("a", record("a", "head-1", "closed"));
      throw new TypeError("lost acknowledgement");
    });
    await expect(
      closeContribution("a", "reviewed", { expectedHeadCommit: "head-1" })
    ).resolves.toMatchObject({
      contributionId: "a",
      closed: true,
      record: { state: "closed", headCommit: "head-1" },
    });
    expect(n.calls).toEqual(["POST a", "GET a"]);
  });

  it("continues after a structured changed-head conflict without replacing the reviewed head", async () => {
    const n = network([record("a"), record("b")], async (id) => {
      if (id === "a") {
        n.current.set("a", record("a", "new"));
        return Response.json(
          {
            error: "Changed since review",
            errorCode: "contribution_head_changed",
          },
          { status: 409 }
        );
      }
      n.current.set(id, record(id, "head-1", "closed"));
      return Response.json({ closed: true });
    });
    render(
      <ReviewedClosePanel
        value={link([
          { contributionId: "a", expectedHeadCommit: "head-1" },
          { contributionId: "b", expectedHeadCommit: "head-1" },
        ])}
      />
    );
    await clickReady(2);
    await screen.findByText("Verified closed");
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST a",
      "POST b",
    ]);
    expect(
      await screen.findByText("Changed since review; excluded")
    ).toBeTruthy();
  });

  it("bounds busy retries and rereads after every attempt", async () => {
    vi.useFakeTimers();
    const n = network([record("a")], async () =>
      Response.json(
        { retryable: true },
        { status: 503, headers: { "Retry-After": "999" } }
      )
    );
    const result = closeContribution("a", "reviewed", {
      expectedHeadCommit: "head-1",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_001);
    const error = await result;
    expect(error).toBeInstanceOf(ReviewedCloseError);
    expect(error).toMatchObject({
      status: 503,
      code: "knowledge_busy",
      stopBatch: true,
    });
    expect(n.calls).toEqual([
      "POST a",
      "GET a",
      "POST a",
      "GET a",
      "POST a",
      "GET a",
      "POST a",
      "GET a",
    ]);
  });

  it("bounds initial reads and excludes a timed-out proposal without writing", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const fetchMock = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("timeout")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ReviewedClosePanel
        value={link([{ contributionId: "a", expectedHeadCommit: null }])}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(screen.getByText("Reading selected proposals…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(
      screen.getByText("Could not read this proposal; excluded.")
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.every(([, options]) => options?.method === "GET")
    ).toBe(true);
  });

  it("continues after POST404 and authoritative GET404 without reporting the missing row closed", async () => {
    const n = network([record("missing"), record("next")], async (id) => {
      if (id === "missing") {
        n.current.delete(id);
        return Response.json({ error: "not found" }, { status: 404 });
      }
      n.current.set(id, record(id, "head-1", "closed"));
      return Response.json({ closed: true });
    });
    render(
      <ReviewedClosePanel
        value={link([
          { contributionId: "missing", expectedHeadCommit: "head-1" },
          { contributionId: "next", expectedHeadCommit: "head-1" },
        ])}
      />
    );
    await clickReady(2);
    await screen.findByText("Verified closed");
    expect(
      screen.getByText("Proposal no longer exists; skipped.")
    ).toBeTruthy();
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST missing",
      "POST next",
    ]);
    expect(n.calls.slice(2, 6)).toEqual([
      "POST missing",
      "GET missing",
      "POST next",
      "GET next",
    ]);
  });

  it("stops an old selection's busy retries after a URL remount", async () => {
    const n = network([record("a"), record("b")], async () =>
      Response.json(
        { retryable: true },
        { status: 503, headers: { "Retry-After": "2" } }
      )
    );
    const { rerender } = render(
      <ReviewedClosePanel
        key="old"
        value={link([{ contributionId: "a", expectedHeadCommit: "head-1" }])}
      />
    );
    const button = await screen.findByRole("button", {
      name: "Close 1 reviewed proposals",
    });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false)
    );
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(n.calls).toEqual(["GET a", "POST a", "GET a"]);
    rerender(
      <ReviewedClosePanel
        key="new"
        value={link([{ contributionId: "b", expectedHeadCommit: "head-1" }])}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST a",
    ]);
    expect(screen.getByText("Proposal b")).toBeTruthy();
  });

  it("contains an unknown close error with one terminal feature event and three total request logs", async () => {
    const lines: Record<string, unknown>[] = [];
    const log = pino(
      {
        level: "info",
        base: { nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d" },
      },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line));
        },
      }
    );
    const user = {
      id: "reviewer",
      walletAddress: null,
      displayName: null,
      avatarColor: null,
    };
    routeClose.mockRejectedValueOnce(new Error("private-driver-diagnostic"));
    const handler = wrapRouteHandlerWithLogging(
      {
        routeId: "knowledge.contributions.close",
        auth: { mode: "required", getSessionUser: async () => user },
        getRequestDependencies: () => ({
          log,
          clock: { now: () => new Date().toISOString() },
          config: { unhandledErrorPolicy: "respond_500" },
        }),
      },
      async (ctx, request, principal) =>
        handleClose(request, "fixture", principal, ctx)
    );
    const response = await handler(
      new NextRequest(
        "https://test.cognidao.org/api/v1/knowledge/contributions/fixture/close",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "close-unknown-proof",
          },
          body: JSON.stringify({
            reason: "reviewed",
            expectedHeadCommit: null,
          }),
        }
      )
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      errorCode: "close_failed",
      retryable: false,
    });
    expect(routeClose).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadCommit: null })
    );
    const terminal = lines.filter(
      (line) => line.event === EVENT_NAMES.KNOWLEDGE_CONTRIBUTION_CLOSE_COMPLETE
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      reqId: "close-unknown-proof",
      routeId: "knowledge.contributions.close",
      status: 500,
      outcome: "error",
      errorCode: "close_failed",
      guarded: true,
    });
    expect(lines).toHaveLength(3);
    expect(JSON.stringify(lines)).not.toContain("private-driver-diagnostic");
  });

  it.each([
    "complete",
    "partial",
    "cancel",
  ])("automatically refreshes the fresh shared inbox count/table after %s settlement", async (mode) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const n = network([record("a"), record("b")], async (id) => {
      if (mode === "cancel") await gate;
      if (mode === "partial" && id === "b")
        throw new TypeError("lost connection");
      n.current.set(id, record(id, "head-1", "closed"));
      return Response.json({ closed: true });
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(["knowledge", "contributions", "open"], {
      contributions: [record("a"), record("b")],
    });
    const value = link([
      { contributionId: "a", expectedHeadCommit: "head-1" },
      { contributionId: "b", expectedHeadCommit: "head-1" },
    ]);
    const { rerender } = render(
      <>
        <CachedInboxSummary />
        <ReviewedClosePanel value={value} />
      </>,
      client
    );
    expect(screen.getByTestId("inbox-count").textContent).toBe("2");
    expect(
      n.fetchMock.mock.calls.filter(([url]) => url.includes("?state=open"))
    ).toHaveLength(0);
    await clickReady(2);
    if (mode === "cancel") {
      await waitFor(() => expect(n.calls).toContain("POST a"));
      rerender(<CachedInboxSummary />);
      await act(async () => {
        release?.();
        await gate;
      });
    }
    await waitFor(() =>
      expect(screen.getByTestId("inbox-count").textContent).toBe(
        mode === "complete" ? "0" : "1"
      )
    );
    expect(screen.getByTestId("inbox-table").textContent).not.toContain(
      "Proposal a"
    );
    expect(
      n.fetchMock.mock.calls.filter(([url]) => url.includes("?state=open"))
    ).toHaveLength(1);
    if (mode !== "complete")
      expect(screen.getByTestId("inbox-table").textContent).toContain(
        "Proposal b"
      );
    if (mode === "cancel")
      expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
        "POST a",
      ]);
  });

  it("explicit refresh reconciles the shared inbox count/table after another actor closes a row", async () => {
    const n = network([record("a")]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(["knowledge", "contributions", "open"], {
      contributions: [record("a")],
    });
    render(
      <>
        <CachedInboxSummary />
        <ReviewedClosePanel
          value={link([{ contributionId: "a", expectedHeadCommit: "head-1" }])}
        />
      </>,
      client
    );
    await screen.findByRole("button", { name: "Close 1 reviewed proposals" });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Refresh results",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    n.current.set("a", record("a", "head-1", "closed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    await waitFor(() =>
      expect(screen.getByTestId("inbox-count").textContent).toBe("0")
    );
    expect(screen.getByTestId("inbox-table").textContent).toBe("");
    expect(n.calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("refresh recovers delayed native closure without replaying an uncertain POST", async () => {
    const n = network([record("a"), record("b")], async () => {
      throw new TypeError("lost acknowledgement before settlement");
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(["knowledge", "contributions", "open"], {
      contributions: [record("a"), record("b")],
    });
    render(
      <>
        <CachedInboxSummary />
        <ReviewedClosePanel
          value={link([
            { contributionId: "a", expectedHeadCommit: "head-1" },
            { contributionId: "b", expectedHeadCommit: "head-1" },
          ])}
        />
      </>,
      client
    );
    await clickReady(2);
    await screen.findByText(
      "Close outcome is unresolved. Reload before trying again."
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Refresh results",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    n.current.set("a", record("a", "head-1", "closed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    await screen.findByText("Verified closed");
    expect(
      screen.queryByText(
        "Close outcome is unresolved. Reload before trying again."
      )
    ).toBeNull();
    expect(screen.getByText("Not attempted")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close 1 reviewed proposals" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("inbox-count").textContent).toBe("1")
    );
    expect(screen.getByTestId("inbox-table").textContent).toBe("Proposal b");
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST a",
    ]);
  });

  it.each([
    "changed",
    "closed",
    "merged",
    "unreadable",
  ] as const)("refresh replaces an unattempted row's current status when it becomes %s", async (state) => {
    const n = network([record("a"), record("b")], async () => {
      throw new TypeError("uncertain first close");
    });
    render(
      <ReviewedClosePanel
        value={link([
          { contributionId: "a", expectedHeadCommit: "head-1" },
          { contributionId: "b", expectedHeadCommit: "head-1" },
        ])}
      />
    );
    await clickReady(2);
    await screen.findByText("Not attempted");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Refresh results",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    if (state === "unreadable") n.current.delete("b");
    else
      n.current.set(
        "b",
        state === "changed"
          ? record("b", "new-head")
          : record("b", "head-1", state)
      );
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    await waitFor(() => expect(screen.queryByText("Not attempted")).toBeNull());
    const expected =
      state === "changed"
        ? "Changed since review; excluded"
        : state === "closed"
          ? "Already closed; excluded"
          : state === "merged"
            ? "Already merged; excluded"
            : "Could not read this proposal; excluded.";
    await screen.findByText(expected);
    expect(
      screen.getByRole("button", { name: "Close 1 reviewed proposals" })
    ).toBeTruthy();
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST a",
    ]);
  });

  it("changing the URL stops future dispatch from the previous frozen selection", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const n = network([record("a"), record("b"), record("c")], async (id) => {
      await gate;
      n.current.set(id, record(id, "head-1", "closed"));
      return Response.json({ closed: true });
    });
    const { rerender } = render(
      <ReviewedClosePanel
        key="old"
        value={link([
          { contributionId: "a", expectedHeadCommit: "head-1" },
          { contributionId: "b", expectedHeadCommit: "head-1" },
        ])}
      />
    );
    await clickReady(2);
    await waitFor(() => expect(n.calls).toContain("POST a"));
    rerender(
      <ReviewedClosePanel
        key="new"
        value={link([{ contributionId: "c", expectedHeadCommit: "head-1" }])}
      />
    );
    await act(async () => {
      release?.();
      await gate;
    });
    await screen.findByText("Proposal c");
    expect(n.calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST a",
    ]);
  });
});
