// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `knowledge-index-projection.test`
 * Purpose: Prove GET /api/v1/knowledge/index is a ROUTING projection — it emits
 *   id + entryType + useWhen and never `content` or `title`. The whole reason
 *   the endpoint exists is that reading 20 retrieval triggers through the browse
 *   list costs the full corpus body (349,692 chars on the operator hub at the
 *   time of writing), so content leaking back in would silently void it.
 * Scope: Route shell with auth + container mocked; the port is stubbed. No DB,
 *   no network.
 * Invariants: INDEX_CARRIES_NO_CONTENT, Q_MATCHES_USEWHEN_ONLY
 * Side-effects: none
 * Links: src/app/api/v1/knowledge/index/route.ts, packages/node-contracts/src/knowledge.index.v1.contract.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const port = vi.hoisted(() => ({
  listDomains: vi.fn(),
  listKnowledge: vi.fn(),
}));
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ knowledgeStorePort: port }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: { log: typeof log },
        request: Request,
        user: { userId: string }
      ) => Promise<Response>
    ) =>
    (request: Request) =>
      handler({ log }, request, { userId: "agent-1" }),
}));

import { GET } from "@/app/api/v1/knowledge/index/route";

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "postgres-crash-observability",
    domain: "build-health",
    title: "Instrument shared Postgres with bounded evidence",
    content: "A".repeat(4000),
    useWhen: "adding enough shared-Postgres evidence to name a crash cause",
    entryType: "guide",
    confidencePct: 55,
    sourceType: "agent",
    sourceRef: null,
    tags: null,
    createdAt: new Date("2026-10-07T00:00:00.000Z"),
    ...overrides,
  };
}

function req(query = ""): Request {
  return new Request(
    `https://test.cognidao.org/api/v1/knowledge/index${query}`
  );
}

describe("GET /api/v1/knowledge/index — routing projection", () => {
  // vi.fn() retains both call history and resolved values across tests, so
  // without this a later assertion reads the previous test's mock.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits the trigger and omits content and title entirely", async () => {
    port.listDomains.mockResolvedValue(["build-health"]);
    port.listKnowledge.mockResolvedValue([storedRow()]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const raw = await res.text();

    // INDEX_CARRIES_NO_CONTENT — assert on the serialized bytes, not the parsed
    // object, so a stray field cannot hide behind a type.
    expect(raw).not.toContain("AAAA");
    expect(raw).not.toContain("Instrument shared Postgres");

    const body = JSON.parse(raw) as {
      items: Array<Record<string, unknown>>;
      domains: string[];
      total: number;
    };
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "domain",
      "entryType",
      "id",
      "useWhen",
    ]);
    expect(body.items[0].useWhen).toBe(
      "adding enough shared-Postgres evidence to name a crash cause"
    );
    expect(body.domains).toEqual(["build-health"]);
    expect(body.total).toBe(1);
  });

  it("is dramatically smaller than the same rows with bodies", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      storedRow({ id: `entry-${i}` })
    );
    port.listDomains.mockResolvedValue(["build-health"]);
    port.listKnowledge.mockResolvedValue(rows);

    const res = await GET(req());
    const projected = (await res.text()).length;
    const withBodies = JSON.stringify(rows).length;

    // 20 rows carrying 4KB bodies each; the projection must be a rounding error
    // next to them or it is not doing its job.
    expect(projected).toBeLessThan(withBodies / 20);
  });

  it("filters to one shelf when domain is given", async () => {
    port.listDomains.mockResolvedValue(["build-health", "method"]);
    port.listKnowledge.mockResolvedValue([storedRow()]);

    await GET(req("?domain=method"));
    expect(port.listKnowledge).toHaveBeenCalledWith(
      "method",
      expect.anything()
    );
    expect(port.listKnowledge).not.toHaveBeenCalledWith(
      "build-health",
      expect.anything()
    );
  });

  it("returns a null trigger rather than failing on un-backfilled rows", async () => {
    port.listDomains.mockResolvedValue(["build-health"]);
    port.listKnowledge.mockResolvedValue([storedRow({ useWhen: null })]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ useWhen: unknown }> };
    expect(body.items[0].useWhen).toBeNull();
  });

  it("rejects an invalid limit instead of silently clamping", async () => {
    const res = await GET(req("?limit=99999"));
    expect(res.status).toBe(400);
  });

  it("forwards q to the port so the trigger filter is not done here", async () => {
    // Q_MATCHES_USEWHEN_ONLY — the route must not reimplement matching; the
    // port owns it (and the Doltgres adapter owns the case-fold), so the index
    // and any other caller cannot drift on what `q` means.
    port.listDomains.mockResolvedValue(["build-health"]);
    port.listKnowledge.mockResolvedValue([storedRow()]);

    const res = await GET(req("?q=naming%20a%20crash%20cause"));
    expect(res.status).toBe(200);
    expect(port.listKnowledge).toHaveBeenCalledWith("build-health", {
      limit: 500,
      q: "naming a crash cause",
    });
  });

  it("omits q entirely when the caller did not ask for one", async () => {
    port.listDomains.mockResolvedValue(["build-health"]);
    port.listKnowledge.mockResolvedValue([storedRow()]);

    await GET(req());
    expect(port.listKnowledge).toHaveBeenCalledWith("build-health", {
      limit: 500,
    });
  });

  it("rejects an over-long q instead of passing it through", async () => {
    const res = await GET(req(`?q=${"x".repeat(321)}`));
    expect(res.status).toBe(400);
  });
});
