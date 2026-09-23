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
 *   - MIGRATION_NEVER_REFUSES_A_MUTATION (task.5135): create and update neither require nor
 *     read a migration; the field is accepted for one release and ignored (see the contract's
 *     MIGRATION_ON_MUTATION_IS_DEPRECATED). The release-side migration rides on `observe` and
 *     comes back as `migration.phase` in the 200 body — there is no migration status code, and
 *     no code→status row a migration can reach, because a database can no longer refuse a
 *     lease.
 *   - IDENTITY_IS_REQUIRED_ON_EVERY_MUTATION: create and update carry `identity`, so a caller
 *     that will not name the consuming node is a 400 before the actuator is even reached
 *     (task.5103). `identity_conflict` is 422 — terminal, because a retry cannot change who
 *     consumed the resource; the Composition reads retryability from the status, not a code
 *     table, so it surfaces as a Failed composite rather than an endless requeue.
 *   - REFUSAL_IS_OBSERVABLE: every non-2xx answer carries a stable `code` the caller can put
 *     in an XR condition, and the actuator has already logged the reason.
 *   - NO_LOOPS: one request = at most one provider transaction. Retry/backoff is the caller's.
 * Side-effects: IO (HTTP request handling; delegates provider + ledger IO to the actuator)
 * Links: ./akash-tx-actuator, @contracts/compute.akash-tx.v1, task.5095, task.5103
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
  // Conflict, and the ONLY self-healing one: the previous attempt is proven closed and its
  // receipt is already settled, so the very next call with the SAME key takes a clean slot.
  // The Composition treats 409 as retryable (`Progressing`), which is exactly right here.
  allocation_rolled_back: 409,
  provider_rejected: 422,
  // Terminal, NOT a conflict to retry: no number of retries changes who consumed the resource.
  identity_conflict: 422,
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

/**
 * Narrow the observe wire shape to the port's exact-optional types. The release-side migration
 * step travels here — the one place on this surface where a migration is mentioned at all —
 * along with the workload + environment that say WHOSE database it is. The actuator refuses to
 * guess those rather than migrate the wrong environment.
 */
function toObserveInput(parsed: AkashTxObserveInput) {
  return {
    cogniKey: parsed.cogniKey,
    ...(parsed.externalName ? { externalName: parsed.externalName } : {}),
    ...(parsed.expectedSourceSha
      ? { expectedSourceSha: parsed.expectedSourceSha }
      : {}),
    ...(parsed.publicHost ? { publicHost: parsed.publicHost } : {}),
    ...(parsed.migration
      ? {
          migration: {
            profile: parsed.migration.profile,
            bundleDigest: parsed.migration.bundleDigest,
            image: parsed.migration.image,
            doltgres: parsed.migration.doltgres,
          },
        }
      : {}),
    ...(parsed.workload ? { workload: parsed.workload } : {}),
    ...(parsed.environment ? { environment: parsed.environment } : {}),
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
            // `input.migration` is deliberately NOT forwarded: it is the deprecated
            // compatibility field, parsed so an un-rematerialized Composition does not 400,
            // and dropped here because nothing downstream may act on it (task.5135).
            body: await deps.actuator.create({
              cogniKey: input.cogniKey,
              environment: input.environment,
              identity: input.identity,
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
              identity: input.identity,
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
      if (error instanceof AkashTxError) {
        // bug.5221: a create that died between receipt_bound and allocation_prepared was
        // invisible for 50+ minutes because this response carried the only record of the
        // failure — to a caller whose logs never reach Loki. The error body stays redacted;
        // the marker line is the in-cluster record.
        deps.log?.warn(
          {
            path: request.path,
            code: error.code,
            causeMessage: error.message,
            ...(error.ownerCogniKey
              ? { ownerCogniKey: error.ownerCogniKey }
              : {}),
          },
          "akash_tx_http_op_failed"
        );
        return errorResponse(error);
      }
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
