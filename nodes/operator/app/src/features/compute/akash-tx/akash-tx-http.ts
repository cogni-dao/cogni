// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-http`
 * Purpose: The private ClusterIP surface of the Akash transaction actuator — four typed
 *   logical operations Crossplane's provider-http calls, plus liveness. Pure dispatch over
 *   the actuator; it adds no policy of its own (task.5095).
 * Scope: Request validation, bearer authentication, and stable code→status mapping. Does NOT
 *   retry, queue, schedule, or hold state. The node:http server factory here is a binding
 *   helper only — it starts nothing on import.
 * Invariants:
 *   - PRIVATE_BY_CONSTRUCTION: a bearer token is REQUIRED at construction; there is no
 *     unauthenticated mode and no public mount. Public compute mutation routes stay tombstoned.
 *   - STRICT_INPUT: strict zod objects — an unknown key is a 400, never a silently ignored field.
 *   - REFUSAL_IS_OBSERVABLE: every non-2xx answer carries a stable `code` the caller can put
 *     in an XR condition, and the actuator has already logged the reason.
 *   - NO_LOOPS: one request = at most one provider transaction. Retry/backoff is the caller's.
 * Side-effects: IO (HTTP request handling; delegates provider + ledger IO to the actuator)
 * Links: ./akash-tx-actuator, @contracts/compute.akash-tx.v1, task.5095
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { ProvisionSpec } from "@cogni/ai-tools";

import {
  type AkashTxCreateInput,
  AkashTxCreateInputSchema,
  AkashTxDeleteInputSchema,
  type AkashTxObserveInput,
  AkashTxObserveInputSchema,
  AkashTxUpdateInputSchema,
} from "@/contracts/compute.akash-tx.v1.contract";
import {
  type AkashTxActuatorPort,
  AkashTxError,
  type AkashTxErrorCode,
} from "@/ports";

import type { AkashTxLogger } from "./akash-tx-actuator";

/** Maximum accepted request body. A workload spec is kilobytes; anything larger is abuse. */
export const AKASH_TX_MAX_BODY_BYTES = 1_048_576;

const STATUS_BY_CODE: Readonly<Record<AkashTxErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  // Conflict, not failure: the caller should come back later with the same key.
  wallet_allocation_blocked: 409,
  allocation_unresolved: 409,
  allocation_ambiguous: 409,
  provider_rejected: 422,
  provider_unavailable: 502,
  // Idempotent by key: a retry resolves the uncertainty from the durable receipt.
  outcome_unknown: 502,
  ledger_unavailable: 503,
};

export interface AkashTxHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  /** Raw JSON text; undefined for GETs. */
  readonly body?: string;
}

export interface AkashTxHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface AkashTxHttpDeps {
  readonly actuator: AkashTxActuatorPort;
  /** Shared secret required on every operation. Empty is rejected at construction. */
  readonly token: string;
  readonly log?: AkashTxLogger;
}

/**
 * Narrow the parsed wire shape to the port's exact-optional types. Absent stays absent —
 * an explicit `undefined` would look like "caller set this" to downstream code.
 */
function toSpec(parsed: AkashTxCreateInput["spec"]): ProvisionSpec {
  return {
    name: parsed.name,
    services: parsed.services.map((service) => ({
      name: service.name,
      image: service.image,
      cpuUnits: service.cpuUnits,
      memoryMi: service.memoryMi,
      storageMi: service.storageMi,
      ...(service.env ? { env: service.env } : {}),
      ...(service.command ? { command: service.command } : {}),
      ...(service.args ? { args: service.args } : {}),
      ...(service.expose
        ? {
            expose: service.expose.map((expose) => ({
              port: expose.port,
              as: expose.as,
              global: expose.global,
              ...(expose.hosts ? { hosts: expose.hosts } : {}),
            })),
          }
        : {}),
    })),
  };
}

function toObserveInput(parsed: AkashTxObserveInput) {
  return {
    cogniKey: parsed.cogniKey,
    ...(parsed.externalName ? { externalName: parsed.externalName } : {}),
    ...(parsed.expectedSourceSha
      ? { expectedSourceSha: parsed.expectedSourceSha }
      : {}),
  };
}

function errorResponse(error: AkashTxError): AkashTxHttpResponse {
  return {
    status: STATUS_BY_CODE[error.code] ?? 500,
    body: {
      code: error.code,
      message: error.message,
      ...(error.ownerCogniKey ? { ownerCogniKey: error.ownerCogniKey } : {}),
    },
  };
}

function authorized(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Pure request dispatcher — the whole HTTP contract, testable without a socket.
 */
export function createAkashTxDispatcher(
  deps: AkashTxHttpDeps
): (request: AkashTxHttpRequest) => Promise<AkashTxHttpResponse> {
  if (!deps.token) {
    throw new Error(
      "akash-tx actuator requires a bearer token; refusing to expose an unauthenticated wallet writer"
    );
  }

  return async function dispatch(
    request: AkashTxHttpRequest
  ): Promise<AkashTxHttpResponse> {
    if (request.method === "GET" && isHealthPath(request.path)) {
      // Deliberately dependency-free: a readiness probe that called the Console API would
      // burn provider rate limit on every kubelet tick.
      return { status: 200, body: { status: "ok" } };
    }
    if (request.method !== "POST") {
      return errorResponse(
        new AkashTxError("invalid_request", "method not allowed")
      );
    }
    if (!authorized(request.authorization, deps.token)) {
      return errorResponse(new AkashTxError("unauthorized", "unauthorized"));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(request.body ?? "");
    } catch {
      return errorResponse(
        new AkashTxError("invalid_request", "body must be JSON")
      );
    }

    try {
      switch (request.path) {
        case "/v1/akash/observe": {
          const input = AkashTxObserveInputSchema.parse(payload);
          return {
            status: 200,
            body: await deps.actuator.observe(toObserveInput(input)),
          };
        }
        case "/v1/akash/create": {
          const input = AkashTxCreateInputSchema.parse(payload);
          return {
            status: 200,
            body: await deps.actuator.create({
              cogniKey: input.cogniKey,
              environment: input.environment,
              spec: toSpec(input.spec),
            }),
          };
        }
        case "/v1/akash/update": {
          const input = AkashTxUpdateInputSchema.parse(payload);
          return {
            status: 200,
            body: await deps.actuator.update({
              cogniKey: input.cogniKey,
              externalName: input.externalName,
              environment: input.environment,
              spec: toSpec(input.spec),
            }),
          };
        }
        case "/v1/akash/delete": {
          const input = AkashTxDeleteInputSchema.parse(payload);
          await deps.actuator.delete(input);
          return { status: 200, body: { deleted: true } };
        }
        default:
          return errorResponse(
            new AkashTxError("not_found", "unknown operation")
          );
      }
    } catch (error) {
      if (error instanceof AkashTxError) return errorResponse(error);
      if (isZodError(error)) {
        return errorResponse(
          new AkashTxError(
            "invalid_request",
            "request failed schema validation"
          )
        );
      }
      // An unexpected throw is never silently downgraded to a retryable answer.
      deps.log?.error(
        {
          path: request.path,
          causeMessage:
            error instanceof Error ? error.message : "unknown cause",
        },
        "akash_tx_http_unhandled_error"
      );
      return {
        status: 500,
        body: { code: "internal", message: "internal error" },
      };
    }
  };
}

function isHealthPath(path: string): boolean {
  return path === "/healthz" || path === "/readyz";
}

function isZodError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError"
  );
}

/**
 * Bind the dispatcher to a node:http server. Nothing listens until the caller says so, and
 * the composition root (image + ClusterIP Service) is deliberately not part of this module.
 */
export function createAkashTxActuatorServer(deps: AkashTxHttpDeps): Server {
  const dispatch = createAkashTxDispatcher(deps);
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > AKASH_TX_MAX_BODY_BYTES) {
        rejected = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ code: "invalid_request", message: "body too large" })
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      void dispatch({
        method: req.method ?? "GET",
        path: (req.url ?? "/").split("?")[0] ?? "/",
        ...(req.headers.authorization
          ? { authorization: req.headers.authorization }
          : {}),
        body: Buffer.concat(chunks).toString("utf8"),
      })
        .then((response) => {
          res.writeHead(response.status, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify(response.body));
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ code: "internal", message: "internal error" })
          );
        });
    });
  });
}
