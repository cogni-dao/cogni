// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `beneficiary-policy-route.test`
 * Purpose: Prove participant-only revocation and the sanitized mutation error boundary.
 * Scope: Route authorization with principal, store, use case, and terminal logger mocked.
 * Invariants: DIRECT_PARTICIPANT_REVOCATION; TYPED_CONFLICT_ONLY;
 * SANITIZED_UNKNOWN_FAILURE; TERMINAL_EVENT_PRIVACY_SAFE.
 * Side-effects: none
 * Links: story.5075, src/app/api/v1/attribution/beneficiary-policies/route.ts
 */

import { ActorBeneficiaryPolicyRejectedError } from "@cogni/attribution-ledger";
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
const wrapperObservability = vi.hoisted(() => ({
  error: vi.fn(),
  requestEnd: vi.fn(),
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
    async (request: Request) => {
      let status = 500;
      try {
        const response = await handler({ log }, request);
        status = response.status;
        return response;
      } catch (error) {
        wrapperObservability.error(error);
        return new Response(
          JSON.stringify({ error: "Internal server error" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          }
        );
      } finally {
        wrapperObservability.requestEnd(status);
      }
    },
}));
vi.mock("@/shared/observability/server", () => ({
  createRouteTerminalLogger: () => terminal,
}));

import { POST } from "@/app/api/v1/attribution/beneficiary-policies/route";

describe("POST beneficiary policy", () => {
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

  it("returns a stable conflict for typed policy rejection", async () => {
    mutateBeneficiaryPolicy.mockRejectedValue(
      new ActorBeneficiaryPolicyRejectedError(
        "acceptor_forbidden",
        "sensitive domain detail"
      )
    );

    const response = await POST(
      new Request(
        "https://example.test/api/v1/attribution/beneficiary-policies",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "accept",
            proposalId: "proposal-1",
            role: "beneficiary",
            evidence: { consent: "direct" },
          }),
        }
      )
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Policy mutation rejected",
      code: "acceptor_forbidden",
    });
    expect(terminal.complete).toHaveBeenCalledOnce();
    expect(terminal.complete).toHaveBeenCalledWith({
      status: 409,
      outcome: "error",
      errorCode: "policy_mutation_rejected",
      reasonCode: "policy_invariant_rejected",
      dimensions: {
        action: "accept",
        semanticCode: "acceptor_forbidden",
      },
    });
    expect(terminal.internalError).not.toHaveBeenCalled();
  });

  it("sanitizes unknown failures and emits one internal terminal", async () => {
    const secret = "postgres://secret@internal.example exploded";
    mutateBeneficiaryPolicy.mockRejectedValue(new Error(secret));

    const response = await POST(
      new Request(
        "https://example.test/api/v1/attribution/beneficiary-policies",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "accept",
            proposalId: "proposal-1",
            role: "beneficiary",
            evidence: { consent: "direct" },
          }),
        }
      )
    );

    expect(response.status).toBe(500);
    const responseBody = await response.text();
    expect(JSON.parse(responseBody)).toEqual({
      error: "Internal server error",
    });
    expect(responseBody).not.toContain(secret);
    expect(terminal.complete).not.toHaveBeenCalled();
    expect(terminal.internalError).toHaveBeenCalledOnce();
    expect(terminal.internalError).toHaveBeenCalledWith();
    expect(JSON.stringify(terminal.internalError.mock.calls)).not.toContain(
      secret
    );
    expect(wrapperObservability.error).not.toHaveBeenCalled();
    expect(wrapperObservability.requestEnd).toHaveBeenCalledOnce();
    expect(wrapperObservability.requestEnd).toHaveBeenCalledWith(500);
  });
});
