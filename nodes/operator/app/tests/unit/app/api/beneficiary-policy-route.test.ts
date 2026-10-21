// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `beneficiary-policy-route.test`
 * Purpose: Prove governance approval cannot replace beneficiary participants.
 * Scope: Route authorization with principal, store, use case, and terminal logger mocked.
 * Invariants: DIRECT_PARTICIPANT_REVOCATION; TERMINAL_EVENT_PRIVACY_SAFE.
 * Side-effects: none
 * Links: story.5075, src/app/api/v1/attribution/beneficiary-policies/route.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getActorBeneficiaryPolicyProposal: vi.fn(),
  resolveCurrentStewardActorId: vi.fn(),
}));
const mutateBeneficiaryPolicy = vi.hoisted(() => vi.fn());
const resolveAttributionActor = vi.hoisted(() => vi.fn());
const resolveRequestPrincipal = vi.hoisted(() => vi.fn());
const terminal = vi.hoisted(() => ({
  complete: vi.fn(),
  internalError: vi.fn(),
  emitted: vi.fn(),
}));
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/app/_lib/auth/request-identity", () => ({
  resolveRequestPrincipal,
}));
vi.mock("@/bootstrap/actor-attribution", () => ({
  mutateBeneficiaryPolicy,
  resolveAttributionActor,
  serializeBeneficiaryProposal: vi.fn(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ attributionStore: store }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (ctx: { log: typeof log }, request: Request) => Promise<Response>
    ) =>
    (request: Request) =>
      handler({ log }, request),
}));
vi.mock("@/shared/observability/server", () => ({
  createRouteTerminalLogger: () => terminal,
}));

import { POST } from "@/app/api/v1/attribution/beneficiary-policies/route";

describe("POST beneficiary policy revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestPrincipal.mockResolvedValue({
      kind: "human",
      principalId: "user:node-1/governance-approver",
      userId: "governance-approver",
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    resolveAttributionActor.mockResolvedValue("actor:governance-approver");
    store.getActorBeneficiaryPolicyProposal.mockResolvedValue({
      id: "proposal-1",
      earnedByActorId: "actor:ai-earner",
      stewardActorId: "actor:governance-approver",
      beneficiaryActorId: "actor:beneficiary",
    });
    store.resolveCurrentStewardActorId.mockResolvedValue(
      "actor:current-steward"
    );
  });

  it("denies an unrelated governance approver without calling the mutation", async () => {
    const response = await POST(
      new Request(
        "https://example.test/api/v1/attribution/beneficiary-policies",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "revoke", proposalId: "proposal-1" }),
        }
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mutateBeneficiaryPolicy).not.toHaveBeenCalled();
    expect(terminal.complete).toHaveBeenCalledOnce();
    expect(terminal.complete).toHaveBeenCalledWith({
      status: 403,
      outcome: "error",
      errorCode: "forbidden",
      reasonCode: "not_policy_participant",
      dimensions: { action: "revoke" },
    });
  });
});
