// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Resolve operator runtime dependencies and dispatch one node-owned action. */

import type { NodeActionDispatchRequest } from "@cogni/node-contracts";

import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import {
  NodeActionUnavailableError,
  resolveNodeActionDependencies,
} from "@/bootstrap/node-actions";
import {
  createNodeActionGateway,
  NodeActionGatewayError,
} from "@/features/nodes/node-action-gateway";
import { resolveNodeRef } from "@/features/nodes/node-lookup";

export type DispatchNodeActionErrorCode =
  | "node_not_found"
  | "node_action_unavailable"
  | "unsupported_action"
  | "request_too_large"
  | "authz_denied"
  | "authz_unavailable"
  | "node_unavailable"
  | "invalid_node_response";

export class DispatchNodeActionError extends Error {
  constructor(readonly code: DispatchNodeActionErrorCode) {
    super(code);
    this.name = "DispatchNodeActionError";
  }
}

export async function dispatchNodeAction(params: {
  readonly id: string;
  readonly userId: string;
  readonly request: NodeActionDispatchRequest;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const node = await resolveNodeRef(resolveServiceDb(), params.id);
  if (!node) throw new DispatchNodeActionError("node_not_found");

  try {
    const config = resolveNodeActionDependencies();
    const response = await createNodeActionGateway(config.gatewayDeps)({
      node,
      issuer: config.issuer,
      environment: config.environment,
      actorId: `user:${params.userId}`,
      action: params.request.action,
      input: params.request.input,
    });
    if (!response.contentType?.toLowerCase().includes("application/json")) {
      throw new DispatchNodeActionError("invalid_node_response");
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new DispatchNodeActionError("invalid_node_response");
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof DispatchNodeActionError) throw error;
    if (error instanceof NodeActionUnavailableError) {
      throw new DispatchNodeActionError("node_action_unavailable");
    }
    if (error instanceof NodeActionGatewayError) {
      throw new DispatchNodeActionError(error.code);
    }
    getContainer().log.warn(
      { nodeId: node.nodeId, action: params.request.action, error },
      "node.actions.dispatch_failed"
    );
    throw new DispatchNodeActionError("node_unavailable");
  }
}
