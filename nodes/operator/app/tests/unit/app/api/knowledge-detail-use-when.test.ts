// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `knowledge-detail-use-when.test`
 * Purpose: Prove GET /api/v1/knowledge/[id] — the permalink target humans click
 *   and AI emits — emits `useWhen` and still parses. This route builds its
 *   response with an explicit `KnowledgeRowSchema.parse({...})` field list, so
 *   any field added to that DTO must be added here too or every single-entry
 *   fetch 500s. Adding `use_when` did exactly that before this test existed.
 * Scope: Route shell with auth + container mocked; the port is stubbed. No DB,
 *   no network.
 * Invariants: DETAIL_ROW_MATCHES_DTO (every KnowledgeRowSchema field is supplied)
 * Side-effects: none
 * Links: src/app/api/v1/knowledge/[id]/route.ts, packages/node-contracts/src/knowledge.list.v1.contract.ts
 */

import { describe, expect, it, vi } from "vitest";

const port = vi.hoisted(() => ({
  getKnowledge: vi.fn(),
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
        user: { userId: string },
        context: { params: Promise<{ id: string }> }
      ) => Promise<Response>
    ) =>
    (request: Request, context: { params: Promise<{ id: string }> }) =>
      handler({ log }, request, { userId: "agent-1" }, context),
}));

import { GET } from "@/app/api/v1/knowledge/[id]/route";

function storedEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "domain-sorts-one-axis",
    domain: "method",
    entityId: null,
    title: "A knowledge shelf sorts on one axis or regrows a catch-all",
    content: "Body.",
    useWhen: "designing or reviewing a knowledge domain set",
    entryType: "rule",
    confidencePct: 40,
    sourceType: "agent",
    sourceRef: null,
    tags: null,
    createdAt: new Date("2026-10-07T00:00:00.000Z"),
    ...overrides,
  };
}

function call(id = "domain-sorts-one-axis"): Promise<Response> {
  return GET(new Request(`https://test.cognidao.org/api/v1/knowledge/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/v1/knowledge/[id] — useWhen in the detail DTO", () => {
  it("returns useWhen when the stored entry has one", async () => {
    port.getKnowledge.mockResolvedValue(storedEntry());

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { useWhen: string | null };
    expect(body.useWhen).toBe("designing or reviewing a knowledge domain set");
  });

  it("returns null — not a 500 — for a row predating the column", async () => {
    // The regression this test exists for: `useWhen` is required-but-nullable
    // in KnowledgeRowSchema, so omitting it from the route's explicit parse
    // list throws and every permalink fetch 500s.
    port.getKnowledge.mockResolvedValue(storedEntry({ useWhen: null }));

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { useWhen: string | null };
    expect(body.useWhen).toBeNull();
  });

  it("returns null when the port omits the field entirely", async () => {
    const { useWhen: _omitted, ...withoutUseWhen } = storedEntry();
    port.getKnowledge.mockResolvedValue(withoutUseWhen);

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { useWhen: string | null };
    expect(body.useWhen).toBeNull();
  });
});
