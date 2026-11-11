// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/identity/services/read-proof-comment`
 * Purpose: Policy service for `github.comment.attestation.v1` (task.0095): read ONE public GitHub issue comment of a registered node's own
 *   repository with the operator's GitHub App, and sign the facts. The node verifies the signature and still decides.
 * Scope: Registry and repository checks, the 45 second result cache, the per-node and route-wide GitHub-call budgets, signing. Does not
 *   parse HTTP, read env, or log (the caller owns the terminal event; the service reports a GitHub failure through `observe`).
 * Invariants:
 *   - EVIDENCE_NOT_VERDICT: the signed claims hold author, times and the exact proof lines. They never say "verified". There is no field for a
 *     challenge secret.
 *   - NODE_REPO_ONLY: the repository is `<parentOwner>/<repo name of the registry row's repoUrl>`, compared case-insensitively. The issue number
 *     is free (the node owns its issue allowlist). Another repository is `repo_not_allowed`.
 *   - PUBLIC_ONLY_VISIBILITY_FIRST: repository visibility (GraphQL `isPrivate`, cached per repository) is read BEFORE the comment. A private or
 *     invisible repository is `repo_not_allowed`, so the operator never reads, caches or signs a fact from it.
 *   - EVERY_MISS_COSTS: each cache-missing GitHub call, including one that ends in a 404 or an error, spends one token of the per-node bucket and
 *     one of the route bucket BEFORE the call. A cache hit costs none. The budget is the operator's own 5000 per hour App rate, shared with flights.
 *   - UNAVAILABLE_IS_NOT_EVIDENCE: GitHub 403, 429, 5xx, a timeout or an unreadable body is `github_unavailable` and nothing is signed. A GitHub
 *     "budget out" answer pauses the route until the reset time (capped).
 *   - FRESHNESS_BY_READAT: the cache holds a read for 45 seconds. Each answer gets its own `jti`, `iat` and echoed `requestNonce`; `readAt` is the
 *     time of the GitHub read. A node accepts an answer whose `readAt` is at most 60 seconds before `iat`.
 * Side-effects: in-memory cache and single-flight map (process-local)
 * Links: https://cognidao.org/work/items/task.0095
 * @public
 */

import {
  GITHUB_COMMENT_ATTESTATION_TTL_SECONDS,
  GITHUB_COMMENT_ATTESTATION_V1,
  GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
  GithubCommentAttestationClaimsSchema,
  GithubCommentAttestationCommentSchema,
  type GithubCommentAttestationRequest,
  identityAttestationAudience,
} from "@cogni/node-contracts";

import type {
  Clock,
  GithubIssueCommentRead,
  GithubProofCommentReaderPort,
  GithubRead,
  IdentityAttestationRepositoryPort,
  IdentityAttestationSignerPort,
} from "@/ports";

export const PROOF_COMMENT_CACHE_TTL_MS = 45_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHED_PROOF_LINES = 200;
const MAX_PAUSE_MS = 10 * 60_000;
const DEFAULT_PAUSE_MS = 60_000;
/** Any node's proof line; the per-request filter narrows it to the asked node. */
const ANY_PROOF_LINE =
  /^cogni-proof:v1:[^:\s]+:[0-9a-f-]{36}:[A-Za-z0-9_-]{22,64}$/;
const ISSUE_REF = /^([^/]+)\/([^#]+)#(\d+)$/;

/** The route's error codes (`invalid_request` is the route's own, before the service). */
export type ProofCommentRefusal =
  | "unknown_node"
  | "repo_not_allowed"
  | "rate_limited"
  | "github_unavailable"
  | "signing_unavailable";

/** At most this many proof lines go into one answer; the whole body never does. */
export const PROOF_COMMENT_MAX_LINES = 5;

/** The proof line grammar for ONE node: `cogni-proof:v1:<nodeId>:<challengeId>:<nonce>`. */
export function proofLinePatternFor(nodeId: string): RegExp {
  const id = nodeId.replace(/[^0-9a-fA-F-]/g, "").toLowerCase();
  return new RegExp(
    `^cogni-proof:v1:${id}:[0-9a-f-]{36}:[A-Za-z0-9_-]{22,64}$`
  );
}

export interface ProofCommentBudget {
  /** Spend one GitHub call for this node and for the route. False = over a cap; nothing is spent then. */
  take(nodeId: string): boolean;
}

export interface ProofCommentObserver {
  /** One line per GitHub failure that ends a request (the dependency signal; the request's terminal event is the caller's). */
  githubFailed(fields: {
    reasonCode: string;
    status: number | null;
    step: "visibility" | "comment" | "edited";
    durationMs: number;
  }): void;
}

export type ProofCommentOutcome =
  | {
      readonly ok: true;
      readonly attestation: string;
      readonly expiresIn: number;
      readonly result: "found" | "not_found";
      readonly userType: string | null;
      readonly githubId: number | null;
      readonly edited: boolean;
      readonly cache: "hit" | "miss";
    }
  | { readonly ok: false; readonly code: ProofCommentRefusal };

interface CachedFact {
  readonly readAtMs: number;
  /** null = GitHub answered 404 (signed as not_found). */
  readonly comment: {
    readonly issueUrl: string;
    readonly userId: number | null;
    readonly userType: string | null;
    readonly login: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastEditedAt: string | null;
    readonly proofLines: readonly string[];
  } | null;
}

type Loaded =
  | { readonly ok: true; readonly fact: CachedFact }
  | { readonly ok: false; readonly code: ProofCommentRefusal };

export interface ProofCommentServiceDeps {
  readonly repository: IdentityAttestationRepositoryPort;
  readonly reader: GithubProofCommentReaderPort;
  readonly signer: IdentityAttestationSignerPort;
  readonly clock: Clock;
  readonly createJti: () => string;
  /** Canonical HTTPS origin of this operator (the pinned issuer). */
  readonly issuer: string;
  /** `NODE_SUBMODULE_PARENT_OWNER`: the org this operator's App covers. */
  readonly parentOwner: string;
  readonly budget: ProofCommentBudget;
  /** Test seam. Default 45 seconds. */
  readonly cacheTtlMs?: number;
}

export interface ProofCommentService {
  read(
    request: GithubCommentAttestationRequest,
    observe: ProofCommentObserver
  ): Promise<ProofCommentOutcome>;
}

export function createProofCommentService(
  deps: ProofCommentServiceDeps
): ProofCommentService {
  const ttl = deps.cacheTtlMs ?? PROOF_COMMENT_CACHE_TTL_MS;
  const nowMs = () => Date.parse(deps.clock.now());
  const facts = new Map<string, CachedFact & { expiresAtMs: number }>();
  const visibility = new Map<
    string,
    { isPrivate: boolean | null; expiresAtMs: number }
  >();
  const inflight = new Map<string, Promise<Loaded>>();
  let pausedUntilMs = 0;

  const trim = <V extends { expiresAtMs: number }>(map: Map<string, V>) => {
    const now = nowMs();
    for (const [key, value] of map)
      if (value.expiresAtMs <= now) map.delete(key);
    while (map.size >= MAX_CACHE_ENTRIES) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  };

  /** A failed GitHub read: never signed, and a "budget out" answer pauses the route. */
  function failed(
    read: Exclude<GithubRead<unknown>, { kind: "ok" }>,
    step: "visibility" | "comment" | "edited",
    startedMs: number,
    observe: ProofCommentObserver
  ): Loaded {
    if (read.kind === "rate_limited") {
      const resetMs = read.resetAt === null ? null : read.resetAt * 1000;
      const until =
        resetMs !== null && resetMs > nowMs()
          ? Math.min(resetMs, nowMs() + MAX_PAUSE_MS)
          : nowMs() + DEFAULT_PAUSE_MS;
      pausedUntilMs = Math.max(pausedUntilMs, until);
    }
    observe.githubFailed({
      reasonCode:
        read.kind === "rate_limited" ? "rate_limited" : read.reasonCode,
      status: read.kind === "rate_limited" ? 429 : read.status,
      step,
      durationMs: Math.max(0, nowMs() - startedMs),
    });
    return { ok: false, code: "github_unavailable" };
  }

  async function load(
    nodeId: string,
    repo: { owner: string; name: string },
    commentId: number,
    observe: ProofCommentObserver
  ): Promise<Loaded> {
    if (nowMs() < pausedUntilMs)
      return { ok: false, code: "github_unavailable" };
    const repoKey = `${repo.owner}/${repo.name}`;

    // 1. Visibility FIRST, cached per repository. A private or invisible repository is never read.
    let seen = visibility.get(repoKey);
    if (!seen || seen.expiresAtMs <= nowMs()) {
      if (!deps.budget.take(nodeId)) return { ok: false, code: "rate_limited" };
      const started = nowMs();
      const read = await deps.reader.repositoryIsPrivate(repo);
      if (read.kind !== "ok")
        return failed(read, "visibility", started, observe);
      trim(visibility);
      seen = { isPrivate: read.value, expiresAtMs: nowMs() + ttl };
      visibility.set(repoKey, seen);
    }
    if (seen.isPrivate !== false)
      return { ok: false, code: "repo_not_allowed" };

    // 2. The comment (REST). A 404 is signed evidence.
    if (!deps.budget.take(nodeId)) return { ok: false, code: "rate_limited" };
    let started = nowMs();
    const comment = await deps.reader.readIssueComment(repo, commentId);
    if (comment.kind !== "ok")
      return failed(comment, "comment", started, observe);
    const readAtMs = nowMs();
    if (comment.value === null)
      return { ok: true, fact: { readAtMs, comment: null } };

    // 3. `lastEditedAt` (GraphQL). An edit in the same second as the post leaves created_at == updated_at; this read does not.
    if (!deps.budget.take(nodeId)) return { ok: false, code: "rate_limited" };
    started = nowMs();
    const edited = await deps.reader.readCommentLastEditedAt(
      repo,
      comment.value.nodeId
    );
    if (edited.kind !== "ok") return failed(edited, "edited", started, observe);
    if (edited.value === null)
      return { ok: true, fact: { readAtMs, comment: null } };

    const c: GithubIssueCommentRead = comment.value;
    const proofLines = c.body
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => ANY_PROOF_LINE.test(line))
      .slice(0, MAX_CACHED_PROOF_LINES);
    return {
      ok: true,
      fact: {
        readAtMs,
        comment: {
          issueUrl: c.issueUrl,
          userId: c.userId,
          userType: c.userType,
          login: c.login,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          lastEditedAt: edited.value.lastEditedAt,
          proofLines,
        },
      },
    };
  }

  return {
    async read(request, observe) {
      // Registry: a node of THIS operator, and the repository name of its registry row.
      const node = await deps.repository.findNode(request.nodeId);
      if (!node || node.nodeId !== request.nodeId)
        return { ok: false, code: "unknown_node" };

      // The repository is `<parentOwner>/<repo name of repoUrl>`, case-insensitive. The issue number is free.
      const parsed = ISSUE_REF.exec(request.issue);
      const owner = deps.parentOwner.trim().toLowerCase();
      if (!parsed || !node.repoName || !owner)
        return { ok: false, code: "repo_not_allowed" };
      const repo = { owner, name: node.repoName.toLowerCase() };
      const askedRepo = `${(parsed[1] as string).toLowerCase()}/${(parsed[2] as string).toLowerCase()}`;
      const repoKey = `${repo.owner}/${repo.name}`;
      if (askedRepo !== repoKey) return { ok: false, code: "repo_not_allowed" };
      const issueNumber = Number(parsed[3]);

      // The cache, then one GitHub read shared by every concurrent request for the same comment.
      const key = `${repoKey}#${request.commentId}`;
      let cache: "hit" | "miss" = "hit";
      let fact: CachedFact | undefined;
      const hit = facts.get(key);
      if (hit && hit.expiresAtMs > nowMs()) {
        fact = hit;
      } else {
        cache = "miss";
        let pending = inflight.get(key);
        if (!pending) {
          pending = load(
            request.nodeId,
            repo,
            request.commentId,
            observe
          ).finally(() => inflight.delete(key));
          inflight.set(key, pending);
        }
        const loaded = await pending;
        if (!loaded.ok) return { ok: false, code: loaded.code };
        fact = loaded.fact;
        if (
          !facts.has(key) ||
          (facts.get(key)?.readAtMs ?? 0) < fact.readAtMs
        ) {
          trim(facts);
          facts.set(key, { ...fact, expiresAtMs: fact.readAtMs + ttl });
        }
      }

      // Sign. Own `jti`, `iat` and the echoed `requestNonce` for every answer, even a cached read.
      const iat = Math.floor(nowMs() / 1000);
      const readAt = Math.min(Math.floor(fact.readAtMs / 1000), iat);
      const c = fact.comment;
      let comment: unknown = null;
      if (c !== null) {
        const pattern = proofLinePatternFor(request.nodeId);
        const found = GithubCommentAttestationCommentSchema.safeParse({
          repo: repoKey,
          issueNumber,
          issueUrl: c.issueUrl,
          commentId: request.commentId,
          userId: c.userId,
          userType: c.userType,
          login: c.login,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          lastEditedAt: c.lastEditedAt,
          proofLines: c.proofLines
            .filter((line) => pattern.test(line))
            .slice(0, PROOF_COMMENT_MAX_LINES),
        });
        // GitHub sent a shape the contract refuses: that is a broken read, not evidence.
        if (!found.success) return { ok: false, code: "github_unavailable" };
        comment = found.data;
      }
      try {
        const claims = GithubCommentAttestationClaimsSchema.parse({
          type: GITHUB_COMMENT_ATTESTATION_V1,
          protocol: GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
          iss: deps.issuer,
          aud: identityAttestationAudience(node.nodeId),
          nodeId: node.nodeId,
          requestNonce: request.requestNonce,
          readAt,
          result: c === null ? "not_found" : "found",
          comment,
          iat,
          exp: iat + GITHUB_COMMENT_ATTESTATION_TTL_SECONDS,
          jti: deps.createJti(),
        });
        return {
          ok: true,
          attestation: await deps.signer.signProofComment(claims),
          expiresIn: GITHUB_COMMENT_ATTESTATION_TTL_SECONDS,
          result: claims.result,
          userType: c?.userType ?? null,
          githubId: c?.userId ?? null,
          edited:
            c !== null &&
            (c.lastEditedAt !== null || c.updatedAt !== c.createdAt),
          cache,
        };
      } catch {
        return { ok: false, code: "signing_unavailable" };
      }
    },
  };
}
