// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/review/remote-knowledge`
 * Purpose: Build and cache the signed read transport git-review uses for each linked node (task.5448).
 * Scope: Composition only. The transport (`createRemoteKnowledgeTransport` of `@cogni-dao/ai-tools`) holds
 *   the target list, the https-only GET rules and the access-ask logic; this module hands it one target,
 *   a signer-backed `authorize`, and a `fetch` that logs one `review.remote_read` event per request.
 * Invariants:
 *   - ONE_TRANSPORT_PER_TARGET: transports are cached per (alias, node id, origin), so the transport's
 *     10-minute access-ask limit holds across runs. The signer is cached once (`git-review-signer`).
 *   - SIGN_PER_CALL: `authorize` returns a fresh `Bearer` assertion per request: `sub` git-review, `aud`
 *     the target node id, scope as asked. No key or token for a target is stored.
 *   - NO_TOKEN_IN_LOGS: `review.remote_read` carries alias, route class, status, kid, duration only; never
 *     a URL, a knowledge id, a header or a body.
 *   - SEAM_FOR_THE_SHARED_PACKAGE: `resolveTransportFactory` reads `createRemoteKnowledgeTransport` from the
 *     installed `@cogni/shared-ai-tools`. A release without it (before PR1 adopts ai-tools >= 0.15), or one
 *     whose reader has no `index` (0.15 through 0.17), is not `available`, and the review route answers a typed
 *     503 before dispatch. See the CD10 seam note on `resolveTransportFactory`.
 * Side-effects: IO (HTTPS GET to a linked node, through the transport)
 * Links: src/ports/remote-knowledge.port.ts, https://cognidao.org/knowledge/operator-identity-model
 * @internal
 */

import type { KnowledgeCapability } from "@cogni/ai-tools";
import * as sharedAiTools from "@cogni/shared-ai-tools";
import type { Logger } from "pino";
import { createRemoteKnowledgeCapability } from "@/adapters/server";
import type { RemoteKnowledgeReadPort, RemoteKnowledgeTarget } from "@/ports";
import { findServiceLinkTarget, type LinkTarget } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { GIT_REVIEW_SERVICE, getGitReviewSigner } from "./git-review-signer";

/** The shape of `createRemoteKnowledgeTransport` from `@cogni-dao/ai-tools`. */
export type RemoteTransportFactory = (deps: {
  readonly targets: readonly RemoteKnowledgeTarget[];
  readonly authorize: (
    target: RemoteKnowledgeTarget,
    scope: string
  ) => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly onAsked?: (event: {
    alias: string;
    scope: string;
    httpStatus: number | null;
  }) => void;
}) => RemoteKnowledgeReadPort;

/**
 * The shared package's transport factory, or undefined when the installed release has none.
 *
 * CD10 SEAM (bounded, task.5448): this runtime lookup bypasses the type checker, so it is a dated yellow.
 *   Owner: flock-leader (story.5167 dev-manager).
 *   Expiry: 2026-12-16.
 *   Closing proof: PR1 pins shared ai-tools with index, and the lookup is replaced by a static import.
 * `tests/unit/bootstrap/review/remote-transport-seam.test.ts` FAILS once the installed package exports the
 * transport with `index`, so the bump cannot leave this seam behind unnoticed.
 */
export function resolveTransportFactory(): RemoteTransportFactory | undefined {
  const candidate = (sharedAiTools as unknown as Record<string, unknown>)
    .createRemoteKnowledgeTransport;
  return typeof candidate === "function"
    ? (candidate as RemoteTransportFactory)
    : undefined;
}

/** The request class of a transport URL, for the log. Never the URL itself. */
export function remoteRouteClass(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "unknown";
  }
  if (pathname === "/api/v1/public/agent/service-enrollments")
    return "enrollment";
  if (pathname === "/api/v1/knowledge") return "knowledge.list";
  if (pathname === "/api/v1/knowledge/index") return "knowledge.index";
  if (pathname.startsWith("/api/v1/knowledge/")) return "knowledge.get";
  return "unknown";
}

/** The `kid` of a Bearer assertion's JWT header (public), or undefined. Never the token. */
export function assertionKid(
  headers: HeadersInit | undefined
): string | undefined {
  try {
    const value = new Headers(headers).get("authorization");
    const jwt = value?.startsWith("Bearer ") ? value.slice(7) : undefined;
    const header = jwt?.split(".")[0];
    if (!header) return undefined;
    const parsed = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8")
    ) as { kid?: unknown };
    return typeof parsed.kid === "string" ? parsed.kid : undefined;
  } catch {
    return undefined;
  }
}

/** A `fetch` that logs ONE `review.remote_read` event per request (alias, route, status, kid). */
export function createLoggedFetch(
  alias: string,
  log: Pick<Logger, "info" | "warn">,
  base: typeof fetch = fetch
): typeof fetch {
  return async (input, init) => {
    const startedAt = Date.now();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const fields = {
      event: EVENT_NAMES.REVIEW_REMOTE_READ,
      alias,
      route: remoteRouteClass(url),
      kid: assertionKid(init?.headers),
    };
    try {
      const response = await base(input, init);
      log.info(
        {
          ...fields,
          status: response.status,
          outcome: response.status < 300 ? "success" : "error",
          durationMs: Date.now() - startedAt,
        },
        EVENT_NAMES.REVIEW_REMOTE_READ
      );
      return response;
    } catch (error) {
      log.warn(
        {
          ...fields,
          status: null,
          outcome: "error",
          errorCode: "network",
          durationMs: Date.now() - startedAt,
        },
        EVENT_NAMES.REVIEW_REMOTE_READ
      );
      throw error;
    }
  };
}

export interface RemoteReaderRegistry {
  /**
   * True only when a transport factory exists AND the reader it builds for `target` exposes `index`.
   * Published ai-tools 0.15 through 0.17 export the transport without `index`; the review's grounding reads the
   * target's index first, so such a reader could never ground a review. Never throws.
   */
  available(target: RemoteKnowledgeTarget): boolean;
  /** The cached reader for a listed target. */
  forTarget(target: RemoteKnowledgeTarget): RemoteKnowledgeReadPort;
}

export interface RemoteReaderRegistryDeps {
  readonly factory: RemoteTransportFactory | undefined;
  /** The `Authorization` header value for one call; throws when the signer is unavailable. */
  readonly authorizationHeader: (request: {
    readonly service: string;
    readonly audienceNodeId: string;
    readonly scope: string;
  }) => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly log: Pick<Logger, "info" | "warn">;
}

/** A registry over injected dependencies (tests build one with fakes). */
export function createRemoteReaderRegistry(
  deps: RemoteReaderRegistryDeps
): RemoteReaderRegistry {
  const readers = new Map<string, RemoteKnowledgeReadPort>();
  return {
    available(target) {
      if (!deps.factory) return false;
      try {
        return typeof this.forTarget(target).index === "function";
      } catch {
        return false;
      }
    },
    forTarget(target) {
      const key = `${target.alias}\n${target.nodeId}\n${target.origin}`;
      const cached = readers.get(key);
      if (cached) return cached;
      const factory = deps.factory;
      if (!factory) throw new Error("remote_transport_unavailable");
      const reader = factory({
        targets: [target],
        authorize: (t, scope) =>
          deps.authorizationHeader({
            service: GIT_REVIEW_SERVICE,
            audienceNodeId: t.nodeId,
            scope,
          }),
        fetchImpl: createLoggedFetch(target.alias, deps.log, deps.fetchImpl),
        onAsked: (event) =>
          deps.log.info(
            {
              event: EVENT_NAMES.REVIEW_REMOTE_READ,
              alias: event.alias,
              route: "enrollment",
              status: event.httpStatus,
              outcome: "access_asked",
            },
            EVENT_NAMES.REVIEW_REMOTE_READ
          ),
      });
      readers.set(key, reader);
      return reader;
    },
  };
}

let registry: RemoteReaderRegistry | undefined;

/** The process-wide registry: shared transport factory, the cached git-review signer, global fetch. */
export function getRemoteReaderRegistry(): RemoteReaderRegistry {
  if (registry) return registry;
  registry = createRemoteReaderRegistry({
    factory: resolveTransportFactory(),
    authorizationHeader: async (request) => {
      const env = serverEnv();
      const result = await getGitReviewSigner({
        seedHex: env.GIT_REVIEW_SIGNING_SEED,
        appBaseUrl: env.APP_BASE_URL,
      });
      if (!result.ok) throw new Error("git_review_signer_unavailable");
      return result.signer.authorizationHeader(request);
    },
    log: makeLogger({ component: "review-remote-read" }),
  });
  return registry;
}

/** Test seam: forget the process-wide registry. */
export function resetRemoteReaderRegistry(): void {
  registry = undefined;
}

/**
 * The stock-tool knowledge capability for a LISTED node id (the run's code subject). Throws when the node is
 * not listed or no transport exists: there is no fallback to the operator's own hub.
 */
export function remoteKnowledgeCapabilityFor(
  nodeId: string,
  deps: {
    readonly findTarget?: (nodeId: string) => LinkTarget | undefined;
    readonly registry?: RemoteReaderRegistry;
  } = {}
): KnowledgeCapability {
  const target = (deps.findTarget ?? findServiceLinkTarget)(nodeId);
  if (!target) throw new Error("knowledge_subject_not_linked");
  const readers = deps.registry ?? getRemoteReaderRegistry();
  if (!readers.available(target))
    throw new Error("remote_transport_unavailable");
  return createRemoteKnowledgeCapability(
    readers.forTarget(target),
    target.alias
  );
}
