// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/adapters/remote-authorization`
 * Purpose: Portable, semantic client for the operator-mediated authorization facade.
 * Scope: Billing-account read checks and grant/revoke only. Never forwards raw tuples.
 * Invariants: NODE_FROM_CREDENTIAL; SAME_NODE_ONLY; NO_RAW_TUPLES; FAIL_CLOSED_WITH_DISTINCTION.
 * Side-effects: IO (HTTP fetch)
 * Links: task.5226, docs/spec/rbac.md
 * @public
 */

import type {
  AuthorizationCheckPort,
  AuthzCheckParams,
  AuthzDecision,
  AuthzWriteDecision,
  BillingAccountGrantAdministrationPort,
  BillingAccountGrantInput,
  BillingAccountRevokeInput,
} from "../index";

export const AUTHORIZATION_FACADE_TOKEN_PREFIX = "cogni_naz_sk_v1_";
const NODE_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TOKEN_PATTERN = new RegExp(
  `^${AUTHORIZATION_FACADE_TOKEN_PREFIX}(${NODE_ID_PATTERN})_[0-9a-f]{64}$`,
  "i"
);
const QUALIFIED_PATTERN = new RegExp(
  `^(user|agent|billing_account):(${NODE_ID_PATTERN})/([^:/]+)$`,
  "i"
);
const LOCAL_ID_PATTERN = new RegExp(`^${NODE_ID_PATTERN}$`, "i");

export interface RemoteAuthorizationAdapterConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

type QualifiedReference = {
  readonly kind: "user" | "agent" | "billing_account";
  readonly nodeId: string;
  readonly localId: string;
};

export function authorizationFacadeNodeIdFromToken(token: string): string {
  const match = TOKEN_PATTERN.exec(token);
  if (!match?.[1]) {
    throw new Error("invalid authorization facade service credential");
  }
  return match[1].toLowerCase();
}

function qualifiedReference(value: string): QualifiedReference | undefined {
  const match = QUALIFIED_PATTERN.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    kind: match[1].toLowerCase() as QualifiedReference["kind"],
    nodeId: match[2].toLowerCase(),
    localId: match[3],
  };
}

function unavailable(reason: string): AuthzDecision {
  return {
    decision: "deny",
    code: "authz_unavailable",
    checks: [],
    reason,
  };
}

function writeUnavailable(reason: string): AuthzWriteDecision {
  return {
    decision: "failure",
    code: "authz_write_unavailable",
    reason,
  };
}

function writeDenied(reason: string): AuthzWriteDecision {
  return {
    decision: "failure",
    code: "authz_write_denied",
    reason,
  };
}

export class RemoteAuthorizationAdapter
  implements AuthorizationCheckPort, BillingAccountGrantAdministrationPort
{
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly nodeId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RemoteAuthorizationAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.serviceToken = config.serviceToken;
    this.nodeId = authorizationFacadeNodeIdFromToken(config.serviceToken);
    this.timeoutMs = config.timeoutMs ?? 1_500;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async check(params: AuthzCheckParams): Promise<AuthzDecision> {
    if (params.action !== "billing_account.read") {
      return unavailable("authorization facade capability is not supported");
    }

    const actor = qualifiedReference(params.actorId);
    const account = qualifiedReference(params.resource);
    const subject = params.subjectId
      ? qualifiedReference(params.subjectId)
      : undefined;
    if (
      !actor ||
      !account ||
      (actor.kind !== "user" && actor.kind !== "agent") ||
      account.kind !== "billing_account" ||
      !LOCAL_ID_PATTERN.test(actor.localId) ||
      !LOCAL_ID_PATTERN.test(account.localId) ||
      (subject !== undefined && subject.kind !== "user") ||
      (subject !== undefined && !LOCAL_ID_PATTERN.test(subject.localId)) ||
      (subject !== undefined && actor.kind !== "agent") ||
      actor.nodeId !== this.nodeId ||
      account.nodeId !== this.nodeId ||
      (subject !== undefined && subject.nodeId !== this.nodeId) ||
      (params.context.nodeId !== undefined &&
        params.context.nodeId.toLowerCase() !== this.nodeId)
    ) {
      return {
        decision: "deny",
        code: "authz_denied",
        checks: [],
        reason: "authorization facade requires same-node billing-account references",
      };
    }

    try {
      const response = await this.post("/api/v1/authorization/check", {
        actor: { kind: actor.kind, id: actor.localId },
        ...(subject !== undefined ? { subjectUserId: subject.localId } : {}),
        billingAccountId: account.localId,
        context: {
          ...(params.context.runId !== undefined
            ? { runId: params.context.runId }
            : {}),
          ...(params.context.toolCallId !== undefined
            ? { toolCallId: params.context.toolCallId }
            : {}),
        },
      });
      if (response.status === 403) {
        return {
          decision: "deny",
          code: "authz_denied",
          checks: [],
          reason: "operator authorization facade denied",
        };
      }
      if (!response.ok) {
        return unavailable(
          `operator authorization facade unavailable (status ${response.status})`
        );
      }
      return (await response.json()) as AuthzDecision;
    } catch (error) {
      return unavailable(
        error instanceof Error ? error.message : "authorization facade unavailable"
      );
    }
  }

  grantBillingAccountAccess(
    input: BillingAccountGrantInput
  ): Promise<AuthzWriteDecision> {
    return this.mutate("grant", input);
  }

  revokeBillingAccountAccess(
    input: BillingAccountRevokeInput
  ): Promise<AuthzWriteDecision> {
    return this.mutate("revoke", input);
  }

  private async mutate(
    operation: "grant" | "revoke",
    input: BillingAccountGrantInput | BillingAccountRevokeInput
  ): Promise<AuthzWriteDecision> {
    if (
      !LOCAL_ID_PATTERN.test(input.grantorUserId) ||
      !LOCAL_ID_PATTERN.test(input.billingAccountId) ||
      !LOCAL_ID_PATTERN.test(input.target.id) ||
      (input.subjectUserId !== undefined &&
        !LOCAL_ID_PATTERN.test(input.subjectUserId)) ||
      (input.role === "reader" && input.subjectUserId !== undefined) ||
      (input.role === "obo" &&
        (input.target.kind !== "agent" || input.subjectUserId === undefined))
    ) {
      return writeDenied("invalid same-node billing-account grant request");
    }
    try {
      const response = await this.post(
        "/api/v1/authorization/billing-account-grants",
        { operation, ...input }
      );
      if (response.status === 403) {
        return writeDenied("operator authorization facade denied mutation");
      }
      if (!response.ok) {
        return writeUnavailable(
          `operator authorization facade rejected mutation (status ${response.status})`
        );
      }
      return (await response.json()) as AuthzWriteDecision;
    } catch (error) {
      return writeUnavailable(
        error instanceof Error ? error.message : "authorization facade unavailable"
      );
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
