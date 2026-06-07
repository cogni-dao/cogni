// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/adapters/openfga-authorization`
 * Purpose: AuthorizationPort implementation backed by OpenFGA check calls.
 * Scope: Maps Cogni authz actions to OpenFGA relations and performs direct or actor/subject dual checks. Does not read env vars.
 * Invariants: AUTHZ_FAIL_CLOSED_WITH_DISTINCTION; OpenFGA is the sole permission/delegation source; no local role policy.
 * Side-effects: IO (OpenFGA SDK check calls)
 * Links: docs/spec/rbac.md, https://openfga.dev/docs/getting-started/setup-sdk-client
 * @public
 */

import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";

import {
  type AuthorizationPort,
  type AuthzCheckParams,
  type AuthzDecision,
  type AuthzSubcheck,
  authzUserResource,
  relationForAuthzAction,
} from "../index";

export interface OpenFgaCheckRequest {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
}

export interface OpenFgaCheckResponse {
  readonly allowed?: boolean;
}

export interface OpenFgaCheckClient {
  check(request: OpenFgaCheckRequest): Promise<OpenFgaCheckResponse>;
}

export interface OpenFgaAuthorizationAdapterConfig {
  readonly apiUrl: string;
  readonly storeId: string;
  readonly authorizationModelId?: string;
  readonly apiToken?: string;
  readonly timeoutMs?: number;
  readonly client?: OpenFgaCheckClient;
}

interface PlannedSubcheck {
  readonly name: "permission" | "delegation";
  readonly user: string;
  readonly relation: string;
  readonly object: string;
}

const DEFAULT_TIMEOUT_MS = 1_500;

function unavailableCheck(check: PlannedSubcheck): AuthzSubcheck {
  return {
    ...check,
    decision: "deny",
    code: "authz_unavailable",
  };
}

function deniedDecision(
  code: "authz_denied" | "authz_unavailable",
  checks: readonly AuthzSubcheck[],
  reason?: string
): AuthzDecision {
  return {
    decision: "deny",
    code,
    checks,
    ...(reason !== undefined ? { reason } : {}),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`OpenFGA check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class OpenFgaAuthorizationAdapter implements AuthorizationPort {
  private readonly client: OpenFgaCheckClient;
  private readonly timeoutMs: number;

  constructor(config: OpenFgaAuthorizationAdapterConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client =
      config.client ??
      new OpenFgaClient({
        apiUrl: config.apiUrl,
        storeId: config.storeId,
        ...(config.apiToken !== undefined
          ? {
              credentials: {
                method: CredentialsMethod.ApiToken,
                config: { token: config.apiToken },
              },
            }
          : {}),
        ...(config.authorizationModelId !== undefined
          ? { authorizationModelId: config.authorizationModelId }
          : {}),
      });
  }

  async check(params: AuthzCheckParams): Promise<AuthzDecision> {
    const checks = this.planChecks(params);
    const results = await Promise.all(
      checks.map((check) => this.runCheck(check))
    );

    if (results.some((result) => result.code === "authz_unavailable")) {
      return deniedDecision(
        "authz_unavailable",
        results,
        "OpenFGA unavailable"
      );
    }

    if (results.every((result) => result.decision === "allow")) {
      return {
        decision: "allow",
        code: "authz_allowed",
        checks: results,
      };
    }

    return deniedDecision("authz_denied", results, "OpenFGA denied");
  }

  private planChecks(params: AuthzCheckParams): readonly PlannedSubcheck[] {
    const permission = {
      name: "permission" as const,
      user: params.subjectId ?? params.actorId,
      relation: relationForAuthzAction(params.action),
      object: params.resource,
    };

    if (!params.subjectId) return [permission];

    return [
      permission,
      {
        name: "delegation",
        user: params.actorId,
        relation: relationForAuthzAction("user.act_as"),
        object: authzUserResource(params.subjectId),
      },
    ];
  }

  private async runCheck(check: PlannedSubcheck): Promise<AuthzSubcheck> {
    try {
      const response = await withTimeout(
        this.client.check({
          user: check.user,
          relation: check.relation,
          object: check.object,
        }),
        this.timeoutMs
      );

      return {
        ...check,
        decision: response.allowed === true ? "allow" : "deny",
        code: response.allowed === true ? "authz_allowed" : "authz_denied",
      };
    } catch {
      return unavailableCheck(check);
    }
  }
}
