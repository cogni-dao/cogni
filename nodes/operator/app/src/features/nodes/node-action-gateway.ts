// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authorize, bind, sign, and dispatch one allowlisted node-owned action. */

import { createHash } from "node:crypto";

import type { AuthorizationPort, AuthzAction } from "@cogni/authorization-core";
import {
  NODE_ACTION_TTL_SECONDS,
  NODE_ACTION_V1,
  NODE_ACTION_V1_PROTOCOL_SHA256,
  NodeActionClaimsSchema,
  nodeActionAudience,
} from "@cogni/node-contracts";

import type {
  Clock,
  NodeActionHttpPort,
  NodeActionHttpResponse,
  NodeActionSignerPort,
  NodeAddressPort,
} from "@/ports";

export const NODE_ACTION_MAX_REQUEST_BYTES = 65_536;

export const NODE_ACTION_REGISTRY = {
  "poly.egress.read": {
    authorizationAction: "node.support_read",
    target: "/api/internal/node-actions/poly/egress-check",
  },
  "poly.wallet.rotate_clob_creds": {
    authorizationAction: "node.repair",
    target: "/api/internal/node-actions/poly/wallet/rotate-clob-creds",
  },
  "poly.wallet.reset_connection": {
    authorizationAction: "node.repair",
    target: "/api/internal/node-actions/poly/wallet/reset-connection",
  },
  "poly.wallet.recover_funds": {
    authorizationAction: "node.recover_funds",
    target: "/api/internal/node-actions/poly/wallet/recover",
  },
} as const satisfies Record<
  string,
  { readonly authorizationAction: AuthzAction; readonly target: string }
>;

export type RegisteredNodeAction = keyof typeof NODE_ACTION_REGISTRY;

export type NodeActionGatewayErrorCode =
  | "unsupported_action"
  | "request_too_large"
  | "authz_denied"
  | "authz_unavailable";

export class NodeActionGatewayError extends Error {
  constructor(readonly code: NodeActionGatewayErrorCode) {
    super(code);
    this.name = "NodeActionGatewayError";
  }
}

export interface NodeActionGatewayDeps {
  readonly authorization: AuthorizationPort | undefined;
  readonly signer: NodeActionSignerPort;
  readonly nodeAddress: NodeAddressPort;
  readonly http: NodeActionHttpPort;
  readonly clock: Clock;
  readonly createJti: () => string;
}

export interface DispatchNodeActionInput {
  readonly node: { readonly nodeId: string; readonly slug: string };
  readonly issuer: string;
  readonly environment: string;
  readonly actorId: `user:${string}` | `agent:${string}` | `service:${string}`;
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export function createNodeActionGateway(deps: NodeActionGatewayDeps) {
  return async function dispatchNodeAction(
    input: DispatchNodeActionInput
  ): Promise<NodeActionHttpResponse> {
    const definition = Object.hasOwn(NODE_ACTION_REGISTRY, input.action)
      ? NODE_ACTION_REGISTRY[input.action as RegisteredNodeAction]
      : undefined;
    if (!definition) throw new NodeActionGatewayError("unsupported_action");

    if (!deps.authorization) {
      throw new NodeActionGatewayError("authz_unavailable");
    }
    const decision = await deps.authorization.check({
      actorId: input.actorId,
      action: definition.authorizationAction,
      resource: `node:${input.node.nodeId}`,
      context: { tenantId: input.node.nodeId, nodeId: input.node.nodeId },
    });
    if (decision.decision !== "allow") {
      throw new NodeActionGatewayError(decision.code);
    }

    const body = JSON.stringify(input.input);
    if (Buffer.byteLength(body, "utf8") > NODE_ACTION_MAX_REQUEST_BYTES) {
      throw new NodeActionGatewayError("request_too_large");
    }
    const iat = Math.floor(Date.parse(deps.clock.now()) / 1000);
    const claims = NodeActionClaimsSchema.parse({
      type: NODE_ACTION_V1,
      protocol: NODE_ACTION_V1_PROTOCOL_SHA256,
      iss: input.issuer,
      aud: nodeActionAudience(input.node.nodeId),
      nodeId: input.node.nodeId,
      environment: input.environment,
      actorId: input.actorId,
      action: input.action,
      target: definition.target,
      bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
      iat,
      exp: iat + NODE_ACTION_TTL_SECONDS,
      jti: deps.createJti(),
    });
    const assertion = await deps.signer.sign(claims);
    const baseUrl = await deps.nodeAddress.resolveNodeAppBaseUrl(
      input.node.slug
    );
    return deps.http.post({
      url: `${baseUrl}${definition.target}`,
      assertion,
      body,
    });
  };
}
