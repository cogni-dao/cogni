// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-service-links/node-host-transport`
 * Purpose: The ONE host-bound transport that sends every authenticated call to a linked node X
 *   (story.0038). Host code gives it the connection and a path; no model, tool or request field does.
 * Scope: GET only, two paths. Adds the X-issued key header at send time, returns the body only.
 * Invariants:
 *   - HOST_BOUND: only `https`, only the stored origin (the connection's audience); `redirect: manual`;
 *     10 s timeout; 1 MiB response cap.
 *   - DEFAULT_DENY_PATHS: GET `/api/v1/knowledge/index` and GET `/api/v1/knowledge/{id}` are the only
 *     allowed calls. Credential routes (`/api/v1/agent/credentials/*`) and everything else are blocked
 *     with `agent.node_call.blocked`. A vault key is unreadable on purpose, so a rotate call through any
 *     model path must stay impossible.
 *   - HEADER_ADDED_LAST: the Authorization header is set after all other options, from the connection.
 *   - NO_RESPONSE_HEADERS: the result carries a status and a body only.
 *   - SCRUB_BACKSTOP: any `cogni_ag_sk_v1_` or `cogni_ag_sk_v2_` pattern in a body becomes `[REDACTED]`.
 *   - REAL_SIZE_CAP: the 1 MiB cap is enforced while reading (content-length refusal plus a streamed byte counter).
 *   - NOTHING_SECRET_LOGGED: events carry the target node, audience host, method, path TEMPLATE, status,
 *     duration and the credential id; never a key, hash, header or body.
 * Side-effects: IO (HTTPS to node X), log events
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038
 * @internal
 */

import type { ResolvedConnection } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";
import { readBoundedBody } from "./bounded-body";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

/** Path templates the transport allows (default-deny). */
const ALLOWED: ReadonlyArray<{
  readonly template: string;
  readonly re: RegExp;
}> = [
  { template: "/api/v1/knowledge/index", re: /^\/api\/v1\/knowledge\/index$/ },
  {
    template: "/api/v1/knowledge/{id}",
    re: /^\/api\/v1\/knowledge\/[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/,
  },
];

const KEY_PATTERN = /cogni_ag_sk_v[12]_[A-Za-z0-9_-]+/g;

/** Replace any agent-key pattern in a body with `[REDACTED]`. */
export function scrubAgentKeys(body: string): string {
  return body.replace(KEY_PATTERN, "[REDACTED]");
}

export interface NodeHostLog {
  info(fields: Record<string, unknown>, msg?: string): void;
  warn(fields: Record<string, unknown>, msg?: string): void;
}

export type NodeHostResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | {
      readonly ok: false;
      readonly reason:
        | "path_not_allowed"
        | "origin_mismatch"
        | "too_large"
        | "unreachable";
    };

export interface NodeHostRequest {
  /** The vaulted link key and the origin it is bound to. */
  readonly connection: Pick<ResolvedConnection, "connectionId" | "credentials">;
  /** Origin the key is valid for (`https://<X host>`), from the connection's audience. */
  readonly audience: string;
  /** Reviewed node (UUID), for the call event only. */
  readonly targetNodeId: string;
  readonly path: string;
}

export function createNodeHostTransport(deps: { readonly log: NodeHostLog }) {
  return {
    async get(request: NodeHostRequest): Promise<NodeHostResult> {
      const started = performance.now();
      const allowed = ALLOWED.find((a) => a.re.test(request.path));
      let url: URL | undefined;
      try {
        url = new URL(request.path, request.audience);
      } catch {
        url = undefined;
      }
      const audienceOrigin = (() => {
        try {
          return new URL(request.audience).origin;
        } catch {
          return null;
        }
      })();
      const blocked = (
        reason: "path_not_allowed" | "origin_mismatch"
      ): NodeHostResult => {
        deps.log.warn(
          {
            event: EVENT_NAMES.AGENT_NODE_CALL_BLOCKED,
            targetNodeId: request.targetNodeId,
            reason,
            method: "GET",
            pathTemplate: allowed?.template ?? "other",
            credentialId: request.connection.connectionId,
          },
          EVENT_NAMES.AGENT_NODE_CALL_BLOCKED
        );
        return { ok: false, reason };
      };
      if (!allowed) return blocked("path_not_allowed");
      if (
        !url ||
        !audienceOrigin ||
        url.protocol !== "https:" ||
        url.origin !== audienceOrigin ||
        url.search !== "" ||
        url.username !== "" ||
        url.password !== ""
      ) {
        return blocked("origin_mismatch");
      }

      const log = (status: number | null, errorCode?: string) => {
        const fields = {
          event: EVENT_NAMES.AGENT_NODE_CALL,
          targetNodeId: request.targetNodeId,
          audienceHost: url.host,
          method: "GET",
          pathTemplate: allowed.template,
          status,
          durationMs: Math.round(performance.now() - started),
          credentialId: request.connection.connectionId,
          ...(errorCode ? { errorCode } : {}),
        };
        if (errorCode) deps.log.warn(fields, EVENT_NAMES.AGENT_NODE_CALL);
        else deps.log.info(fields, EVENT_NAMES.AGENT_NODE_CALL);
      };

      // The body is read inside the try: a stream failure is `unreachable`, an oversized body `too_large`.
      try {
        const response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          // HEADER_ADDED_LAST: nothing below this object can override it.
          headers: {
            accept: "application/json",
            authorization: `Bearer ${request.connection.credentials.accessToken}`,
          },
        });
        const body = await readBoundedBody(response, MAX_BODY_BYTES);
        if (!body.ok) {
          log(response.status, "node_response_too_large");
          return { ok: false, reason: "too_large" };
        }
        log(response.status);
        return {
          ok: true,
          status: response.status,
          body: scrubAgentKeys(body.bytes.toString("utf8")),
        };
      } catch {
        log(null, "node_unreachable");
        return { ok: false, reason: "unreachable" };
      }
    },
  };
}

export type NodeHostTransport = ReturnType<typeof createNodeHostTransport>;
