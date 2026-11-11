// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/identity/github-proof-comment-reader`
 * Purpose: Reads PUBLIC GitHub data for the proof-comment attestation route (task.0095) with the operator's own GitHub App.
 * Scope: Three GitHub calls (repository visibility, one issue comment, its `lastEditedAt`), one App installation token. Signs nothing, decides
 *   nothing, caches nothing: the feature service counts and caches each call.
 * Invariants:
 *   - SMALLEST_GRANT: the installation token is cut to ONE repository and `metadata: read`. The data is public, so no `issues` grant is asked for.
 *     (F1 of task.0095 proves this on the live App; the permission is the single constant `PROOF_READ_PERMISSIONS`.)
 *   - NO_CALLER_URL: every URL is built here from an owner, a repo name and an integer, or is the fixed GraphQL endpoint. `redirect: "error"`.
 *   - BOUNDED: a 3 second timeout per call and a 256 KB body cap, so three calls stay inside the node's 8 second budget.
 *   - UNAVAILABLE_IS_NOT_EVIDENCE: 403, 429, 5xx, a timeout, an oversize or unreadable body is an `error` or `rate_limited` read, never a 404.
 *   - NO_SECRET_IN_OUTPUT: no token, header or body text leaves this module in an error; only a reason code and a status.
 * Side-effects: IO (GitHub REST and GraphQL)
 * Links: https://cognidao.org/work/items/task.0095
 * @internal
 */

import { createAppAuth } from "@octokit/auth-app";

import type {
  GithubIssueCommentRead,
  GithubProofCommentReaderPort,
  GithubRead,
} from "@/ports";

export const PROOF_READ_PERMISSIONS = { metadata: "read" } as const;
export const GITHUB_COMMENT_MAX_BODY_BYTES = 256 * 1024;
export const GITHUB_CALL_TIMEOUT_MS = 3000;

const API = "https://api.github.com";

export interface GithubProofCommentReaderConfig {
  readonly appId: string;
  readonly privateKey: string;
  /** Test seam. Default: global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam: a token source. Default: the App installation token cut to one repository. */
  readonly getToken?: (repo: {
    owner: string;
    name: string;
  }) => Promise<string>;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Read at most `GITHUB_COMMENT_MAX_BODY_BYTES`; null when the body is larger or cannot be read. */
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > GITHUB_COMMENT_MAX_BODY_BYTES) {
    res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.length > GITHUB_COMMENT_MAX_BODY_BYTES ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > GITHUB_COMMENT_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function failFromStatus(res: Response): GithubRead<never> {
  res.body?.cancel().catch(() => undefined);
  const status = res.status;
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = Number(res.headers.get("retry-after") ?? Number.NaN);
  if (
    status === 429 ||
    (status === 403 && (remaining === "0" || Number.isFinite(retryAfter)))
  ) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? Number.NaN);
    const resetAt = Number.isFinite(reset)
      ? reset
      : Number.isFinite(retryAfter)
        ? Math.floor(Date.now() / 1000) + retryAfter
        : null;
    return { kind: "rate_limited", resetAt };
  }
  return {
    kind: "error",
    reasonCode:
      status === 403 ? "http_403" : status >= 500 ? "http_5xx" : "http_4xx",
    status,
  };
}

export class GithubAppProofCommentReader
  implements GithubProofCommentReaderPort
{
  private readonly doFetch: typeof fetch;
  private readonly appAuth: ReturnType<typeof createAppAuth> | null;
  private readonly installationIds = new Map<string, number>();

  constructor(private readonly config: GithubProofCommentReaderConfig) {
    this.doFetch = config.fetch ?? fetch;
    this.appAuth = config.getToken
      ? null
      : createAppAuth({ appId: config.appId, privateKey: config.privateKey });
  }

  async repositoryIsPrivate(repo: {
    owner: string;
    name: string;
  }): Promise<GithubRead<boolean | null>> {
    const data = await this.graphql(
      repo,
      "query($o:String!,$n:String!){repository(owner:$o,name:$n){isPrivate}}",
      { o: repo.owner, n: repo.name }
    );
    if (data.kind !== "ok") return data;
    const repository = data.value.data?.repository;
    if (repository === null || repository === undefined) {
      // GitHub answers NOT_FOUND in `errors` when the App cannot see the repository: "not visible" is not "public".
      const notFound = data.value.errors?.some((e) => e.type === "NOT_FOUND");
      return notFound || repository === null
        ? { kind: "ok", value: null }
        : { kind: "error", reasonCode: "bad_body", status: 200 };
    }
    return typeof repository.isPrivate === "boolean"
      ? { kind: "ok", value: repository.isPrivate }
      : { kind: "error", reasonCode: "bad_body", status: 200 };
  }

  async readIssueComment(
    repo: { owner: string; name: string },
    commentId: number
  ): Promise<GithubRead<GithubIssueCommentRead | null>> {
    if (!Number.isSafeInteger(commentId) || commentId <= 0)
      return { kind: "ok", value: null };
    const res = await this.call(
      repo,
      `${API}/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`,
      { method: "GET" }
    );
    if (res.kind !== "ok") return res;
    if (res.value.status === 404) {
      res.value.body?.cancel().catch(() => undefined);
      return { kind: "ok", value: null };
    }
    if (res.value.status !== 200) return failFromStatus(res.value);
    const text = await readCapped(res.value).catch(() => null);
    if (text === null)
      return { kind: "error", reasonCode: "too_large", status: 200 };
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { kind: "error", reasonCode: "bad_body", status: 200 };
    }
    const user =
      typeof json.user === "object" && json.user !== null
        ? (json.user as Record<string, unknown>)
        : null;
    const nodeId = asString(json.node_id);
    const issueUrl = asString(json.issue_url);
    const createdAt = asString(json.created_at);
    const updatedAt = asString(json.updated_at);
    if (!nodeId || !issueUrl || !createdAt || !updatedAt)
      return { kind: "error", reasonCode: "bad_body", status: 200 };
    return {
      kind: "ok",
      value: {
        nodeId,
        issueUrl,
        userId: user && typeof user.id === "number" ? user.id : null,
        userType: user ? asString(user.type) : null,
        login: user ? asString(user.login) : null,
        body: asString(json.body) ?? "",
        createdAt,
        updatedAt,
      },
    };
  }

  async readCommentLastEditedAt(
    repo: { owner: string; name: string },
    commentNodeId: string
  ): Promise<GithubRead<{ readonly lastEditedAt: string | null } | null>> {
    const data = await this.graphql(
      repo,
      "query($id:ID!){node(id:$id){... on IssueComment{lastEditedAt}}}",
      { id: commentNodeId }
    );
    if (data.kind !== "ok") return data;
    if (data.value.errors?.length && !data.value.data)
      return { kind: "error", reasonCode: "bad_body", status: 200 };
    const node = (data.value.data as { node?: unknown } | undefined)?.node;
    if (node === null) return { kind: "ok", value: null };
    if (typeof node !== "object" || node === null)
      return { kind: "error", reasonCode: "bad_body", status: 200 };
    const edited = (node as { lastEditedAt?: unknown }).lastEditedAt;
    if (edited === null) return { kind: "ok", value: { lastEditedAt: null } };
    return typeof edited === "string"
      ? { kind: "ok", value: { lastEditedAt: edited } }
      : { kind: "error", reasonCode: "bad_body", status: 200 };
  }

  private async token(repo: { owner: string; name: string }): Promise<string> {
    if (this.config.getToken) return this.config.getToken(repo);
    const appAuth = this.appAuth;
    if (!appAuth) throw new Error("auth");
    const key = `${repo.owner}/${repo.name}`;
    let installationId = this.installationIds.get(key);
    if (!installationId) {
      const { token } = await appAuth({ type: "app" });
      const res = await this.doFetch(`${API}/repos/${key}/installation`, {
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "cogni-operator-proof-reader",
        },
      });
      if (!res.ok) {
        res.body?.cancel().catch(() => undefined);
        throw new Error("auth");
      }
      const data = (await res.json()) as { id?: number };
      if (typeof data.id !== "number") throw new Error("auth");
      installationId = data.id;
      this.installationIds.set(key, installationId);
    }
    const { token } = await appAuth({
      type: "installation",
      installationId,
      repositoryNames: [repo.name],
      permissions: PROOF_READ_PERMISSIONS,
    });
    return token;
  }

  private async call(
    repo: { owner: string; name: string },
    url: string,
    init: { method: "GET" | "POST"; body?: string }
  ): Promise<
    | { kind: "ok"; value: Response }
    | Extract<GithubRead<never>, { kind: "error" }>
  > {
    let token: string;
    try {
      token = await this.token(repo);
    } catch {
      return { kind: "error", reasonCode: "auth", status: null };
    }
    try {
      const value = await this.doFetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "cogni-operator-proof-reader",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
      return { kind: "ok", value };
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        kind: "error",
        reasonCode: timedOut ? "timeout" : "network",
        status: null,
      };
    }
  }

  private async graphql(
    repo: { owner: string; name: string },
    query: string,
    variables: Record<string, string>
  ): Promise<
    GithubRead<{
      data?: {
        repository?: { isPrivate?: unknown } | null;
        node?: unknown;
      } | null;
      errors?: { type?: string }[];
    }>
  > {
    const res = await this.call(repo, `${API}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    if (res.kind !== "ok") return res;
    if (res.value.status !== 200) return failFromStatus(res.value);
    const text = await readCapped(res.value).catch(() => null);
    if (text === null)
      return { kind: "error", reasonCode: "too_large", status: 200 };
    try {
      const parsed = JSON.parse(text) as {
        data?: {
          repository?: { isPrivate?: unknown } | null;
          node?: unknown;
        } | null;
        errors?: { type?: string }[];
      };
      if (parsed.errors?.some((e) => e.type === "RATE_LIMITED"))
        return { kind: "rate_limited", resetAt: null };
      return { kind: "ok", value: parsed };
    } catch {
      return { kind: "error", reasonCode: "bad_body", status: 200 };
    }
  }
}
