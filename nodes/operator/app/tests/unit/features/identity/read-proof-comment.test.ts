// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Unit tests for the proof-comment attestation policy (task.0095) at its seams: a fake GitHub reader, the real Ed25519 signer, and a
 * verifier that checks the signed token the way a node does (`typ`, `type`, `aud`, echoed `requestNonce`).
 */

import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  GithubCommentAttestationClaimsSchema,
  IdentityAttestationClaimsSchema,
} from "@cogni/node-contracts";
import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { JoseIdentityAttestationSigner } from "@/adapters/server/identity/identity-attestation.adapter";
import {
  createProofCommentService,
  PROOF_COMMENT_CACHE_TTL_MS,
} from "@/features/identity/services/read-proof-comment";
import type {
  GithubIssueCommentRead,
  GithubProofCommentReaderPort,
  GithubRead,
} from "@/ports";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "request_nonce_0123456789abcdef_ABCDEF";
const LINE = `cogni-proof:v1:${NODE_ID}:33333333-3333-4333-8333-333333333333:AAAAAAAAAAAAAAAAAAAAAA`;
const OTHER_NODE_LINE = `cogni-proof:v1:99999999-9999-4999-8999-999999999999:33333333-3333-4333-8333-333333333333:AAAAAAAAAAAAAAAAAAAAAA`;
const ISSUER = "https://cognidao.org";

const COMMENT: GithubIssueCommentRead = {
  nodeId: "IC_node",
  issueUrl: "https://api.github.com/repos/cogni-dao/node-template/issues/341",
  userId: 12345,
  userType: "User",
  login: "An-Agent",
  body: `hello\r\n${LINE}\r\n${OTHER_NODE_LINE}\nnot a line`,
  createdAt: "2026-11-11T20:00:00Z",
  updatedAt: "2026-11-11T20:00:00Z",
};

const ok = <T>(value: T): GithubRead<T> => ({ kind: "ok", value });

function setup(
  overrides: Partial<GithubProofCommentReaderPort> = {},
  opts: { budget?: (nodeId: string) => boolean; repoName?: string | null } = {}
) {
  const { privateKey } = generateKeyPairSync("ed25519");
  let nowMs = Date.parse("2026-11-11T20:00:10Z");
  const reader = {
    repositoryIsPrivate: vi.fn(async () => ok<boolean | null>(false)),
    readIssueComment: vi.fn(async () =>
      ok<GithubIssueCommentRead | null>(COMMENT)
    ),
    readCommentLastEditedAt: vi.fn(async () =>
      ok<{ lastEditedAt: string | null } | null>({ lastEditedAt: null })
    ),
    ...overrides,
  } satisfies GithubProofCommentReaderPort;
  const take = vi.fn(opts.budget ?? (() => true));
  const failures: unknown[] = [];
  let jti = 0;
  const service = createProofCommentService({
    repository: {
      findNode: async (id: string) =>
        id === NODE_ID
          ? {
              nodeId: NODE_ID,
              slug: "node-template",
              repoOwner: "cogni-dao",
              repoName:
                opts.repoName === undefined ? "node-template" : opts.repoName,
              deployEnvs: ["production"],
            }
          : null,
    },
    reader,
    signer: new JoseIdentityAttestationSigner(privateKey as KeyObject),
    clock: { now: () => new Date(nowMs).toISOString() },
    createJti: () =>
      `00000000-0000-4000-8000-${String(++jti).padStart(12, "0")}`,
    issuer: ISSUER,
    parentOwner: "Cogni-DAO",
    budget: { take },
  });
  const observe = { githubFailed: (f: unknown) => failures.push(f) };
  const request = (over: Record<string, unknown> = {}) => ({
    nodeId: NODE_ID,
    requestNonce: NONCE,
    issue: "cogni-dao/node-template#341",
    commentId: 4_000_000_001,
    ...over,
  });
  return {
    service,
    reader,
    take,
    failures,
    observe,
    request,
    publicKey: createPublicKey(privateKey),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("proof comment attestation service", () => {
  it("signs a found comment: own typ and type, aud from the node, echoed nonce, exact proof lines for this node only", async () => {
    const t = setup();
    const out = await t.service.read(t.request(), t.observe);
    expect(out).toMatchObject({
      ok: true,
      result: "found",
      cache: "miss",
      githubId: 12345,
      edited: false,
    });
    if (!out.ok) return;
    const { payload, protectedHeader } = await jwtVerify(
      out.attestation,
      t.publicKey,
      {
        typ: "github.comment.attestation+jwt",
        issuer: ISSUER,
        audience: `urn:cogni:node:${NODE_ID}`,
      }
    );
    expect(protectedHeader.typ).toBe("github.comment.attestation+jwt");
    const claims = GithubCommentAttestationClaimsSchema.parse(payload);
    expect(claims).toMatchObject({
      requestNonce: NONCE,
      result: "found",
      nodeId: NODE_ID,
    });
    expect(claims.exp - claims.iat).toBe(120);
    expect(claims.readAt).toBeLessThanOrEqual(claims.iat);
    expect(claims.comment).toMatchObject({
      repo: "cogni-dao/node-template",
      issueNumber: 341,
      issueUrl: COMMENT.issueUrl,
      userId: 12345,
      lastEditedAt: null,
      proofLines: [LINE],
    });
    // The whole body never leaves, and no verdict does.
    expect(JSON.stringify(payload)).not.toContain("hello");
    expect(JSON.stringify(payload)).not.toContain("verified");
  });

  it("type confusion F2: the proof token fails the identity verifier, and an identity-typed header fails the proof verifier", async () => {
    const t = setup();
    const out = await t.service.read(t.request(), t.observe);
    if (!out.ok) throw new Error("expected a signed answer");
    await expect(
      jwtVerify(out.attestation, t.publicKey, { typ: "JWT" })
    ).rejects.toThrow();
    expect(
      IdentityAttestationClaimsSchema.safeParse(
        (await jwtVerify(out.attestation, t.publicKey)).payload
      ).success
    ).toBe(false);
    const { privateKey } = generateKeyPairSync("ed25519");
    const identityToken = await new JoseIdentityAttestationSigner(
      privateKey
    ).sign({
      type: "identity.attestation.v1",
      protocol:
        "e1cac953eb90a7102da2569494ebefed58d0763ea10aee4fdb2d8e1b14c5e8d8",
      iss: ISSUER,
      aud: `urn:cogni:node:${NODE_ID}`,
      nodeId: NODE_ID,
      nonce: NONCE,
      targetOrigin: ISSUER,
      github: { id: "1", login: null },
      iat: 1,
      exp: 2,
      jti: "33333333-3333-4333-8333-333333333333",
    });
    await expect(
      jwtVerify(identityToken, createPublicKey(privateKey), {
        typ: "github.comment.attestation+jwt",
      })
    ).rejects.toThrow();
  });

  it("a GitHub 404 is signed as not_found with comment null", async () => {
    const t = setup({
      readIssueComment: vi.fn(async () =>
        ok<GithubIssueCommentRead | null>(null)
      ),
    });
    const out = await t.service.read(t.request(), t.observe);
    expect(out).toMatchObject({
      ok: true,
      result: "not_found",
      githubId: null,
    });
    if (!out.ok) return;
    const claims = GithubCommentAttestationClaimsSchema.parse(
      (await jwtVerify(out.attestation, t.publicKey)).payload
    );
    expect(claims.comment).toBeNull();
    expect(t.reader.readCommentLastEditedAt).not.toHaveBeenCalled();
  });

  it("reports an edit: lastEditedAt set while created_at equals updated_at (F3)", async () => {
    const t = setup({
      readCommentLastEditedAt: vi.fn(async () =>
        ok<{ lastEditedAt: string | null } | null>({
          lastEditedAt: "2026-11-11T20:00:00Z",
        })
      ),
    });
    const out = await t.service.read(t.request(), t.observe);
    expect(out).toMatchObject({ ok: true, edited: true });
    if (!out.ok) return;
    const claims = GithubCommentAttestationClaimsSchema.parse(
      (await jwtVerify(out.attestation, t.publicKey)).payload
    );
    expect(claims.comment?.lastEditedAt).toBe("2026-11-11T20:00:00Z");
  });

  it("passes the ACTUAL issue url through when the comment sits on another issue (the node answers wrong_issue)", async () => {
    const t = setup({
      readIssueComment: vi.fn(async () =>
        ok<GithubIssueCommentRead | null>({
          ...COMMENT,
          issueUrl:
            "https://api.github.com/repos/cogni-dao/node-template/issues/7",
        })
      ),
    });
    const out = await t.service.read(t.request(), t.observe);
    if (!out.ok) throw new Error("expected a signed answer");
    const claims = GithubCommentAttestationClaimsSchema.parse(
      (await jwtVerify(out.attestation, t.publicKey)).payload
    );
    expect(claims.comment?.issueNumber).toBe(341);
    expect(claims.comment?.issueUrl).toMatch(/issues\/7$/);
  });

  it("F5 cache: ten nonces on one comment inside 45 s make ONE set of GitHub reads, each answer still has its own nonce and jti", async () => {
    const t = setup();
    const nonces = Array.from(
      { length: 10 },
      (_, i) => `${NONCE.slice(0, -2)}${String(i).padStart(2, "0")}`
    );
    const outs = [];
    for (const requestNonce of nonces)
      outs.push(await t.service.read(t.request({ requestNonce }), t.observe));
    expect(outs.map((o) => o.ok && o.cache)).toEqual([
      "miss",
      ...Array(9).fill("hit"),
    ]);
    expect(t.reader.repositoryIsPrivate).toHaveBeenCalledTimes(1);
    expect(t.reader.readIssueComment).toHaveBeenCalledTimes(1);
    expect(t.reader.readCommentLastEditedAt).toHaveBeenCalledTimes(1);
    expect(t.take).toHaveBeenCalledTimes(3); // a hit costs nothing
    const claims = await Promise.all(
      outs.map(async (o) =>
        o.ok ? (await jwtVerify(o.attestation, t.publicKey)).payload : null
      )
    );
    expect(new Set(claims.map((c) => c?.requestNonce)).size).toBe(10);
    expect(new Set(claims.map((c) => c?.jti)).size).toBe(10);
    // After the window the read is repeated, and the edit becomes visible.
    t.advance(PROOF_COMMENT_CACHE_TTL_MS + 1);
    const later = await t.service.read(t.request(), t.observe);
    expect(later).toMatchObject({ ok: true, cache: "miss" });
    expect(t.reader.readIssueComment).toHaveBeenCalledTimes(2);
  });

  it("concurrent requests for one comment share one GitHub read (single flight)", async () => {
    const t = setup();
    const outs = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        t.service.read(
          t.request({ requestNonce: `${NONCE.slice(0, -1)}${i}` }),
          t.observe
        )
      )
    );
    expect(outs.every((o) => o.ok)).toBe(true);
    expect(t.reader.readIssueComment).toHaveBeenCalledTimes(1);
  });

  it("caches a 404 too, and every cache-missing call counts against the budget, 404 and errors included", async () => {
    const t = setup({
      readIssueComment: vi.fn(async () =>
        ok<GithubIssueCommentRead | null>(null)
      ),
    });
    await t.service.read(t.request(), t.observe);
    await t.service.read(t.request(), t.observe);
    expect(t.reader.readIssueComment).toHaveBeenCalledTimes(1);
    expect(t.take).toHaveBeenCalledTimes(2); // visibility + the comment that ended in a 404

    const failing = setup({
      readIssueComment: vi.fn(
        async (): Promise<GithubRead<GithubIssueCommentRead | null>> => ({
          kind: "error",
          reasonCode: "http_5xx",
          status: 502,
        })
      ),
    });
    expect(
      await failing.service.read(failing.request(), failing.observe)
    ).toEqual({ ok: false, code: "github_unavailable" });
    expect(failing.take).toHaveBeenCalledTimes(2); // visibility + the failed comment read
    expect(failing.failures).toEqual([
      expect.objectContaining({
        reasonCode: "http_5xx",
        status: 502,
        step: "comment",
      }),
    ]);
    // an error is not cached and not signed: the next request reads again
    await failing.service.read(failing.request(), failing.observe);
    expect(failing.reader.readIssueComment).toHaveBeenCalledTimes(2);
  });

  it("F8 visibility FIRST: a private or invisible repository is repo_not_allowed before the comment is read or signed", async () => {
    for (const value of [true, null]) {
      const t = setup({
        repositoryIsPrivate: vi.fn(async () => ok<boolean | null>(value)),
      });
      expect(await t.service.read(t.request(), t.observe)).toEqual({
        ok: false,
        code: "repo_not_allowed",
      });
      expect(t.reader.readIssueComment).not.toHaveBeenCalled();
      expect(t.reader.readCommentLastEditedAt).not.toHaveBeenCalled();
    }
  });

  it("visibility is cached per repository: a second comment of the same repo does not read it again", async () => {
    const t = setup();
    await t.service.read(t.request(), t.observe);
    await t.service.read(t.request({ commentId: 4_000_000_002 }), t.observe);
    expect(t.reader.repositoryIsPrivate).toHaveBeenCalledTimes(1);
    expect(t.reader.readIssueComment).toHaveBeenCalledTimes(2);
  });

  it("F7 case: owner and repo compare case-insensitively with the fleet owner and the registry repo name; the signed repo is lowercase", async () => {
    const t = setup();
    const out = await t.service.read(
      t.request({ issue: "Cogni-DAO/Node-Template#341" }),
      t.observe
    );
    if (!out.ok) throw new Error("expected a signed answer");
    expect(t.reader.repositoryIsPrivate).toHaveBeenCalledWith({
      owner: "cogni-dao",
      name: "node-template",
    });
    const claims = GithubCommentAttestationClaimsSchema.parse(
      (await jwtVerify(out.attestation, t.publicKey)).payload
    );
    expect(claims.comment?.repo).toBe("cogni-dao/node-template");
  });

  it("refuses another repository, an unknown node and a registry row with no repo name, before any GitHub call", async () => {
    const t = setup();
    expect(
      await t.service.read(t.request({ issue: "cogni-dao/poly#1" }), t.observe)
    ).toEqual({ ok: false, code: "repo_not_allowed" });
    expect(
      await t.service.read(
        t.request({ issue: "attacker/node-template#1" }),
        t.observe
      )
    ).toEqual({ ok: false, code: "repo_not_allowed" });
    expect(
      await t.service.read(
        t.request({ nodeId: "44444444-4444-4444-8444-444444444444" }),
        t.observe
      )
    ).toEqual({ ok: false, code: "unknown_node" });
    const noName = setup({}, { repoName: null });
    expect(await noName.service.read(noName.request(), noName.observe)).toEqual(
      { ok: false, code: "repo_not_allowed" }
    );
    expect(t.reader.repositoryIsPrivate).not.toHaveBeenCalled();
    expect(noName.reader.repositoryIsPrivate).not.toHaveBeenCalled();
  });

  it("F5 budget: over a cap the answer is rate_limited and GitHub is not called", async () => {
    const t = setup({}, { budget: () => false });
    expect(await t.service.read(t.request(), t.observe)).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(t.reader.repositoryIsPrivate).not.toHaveBeenCalled();
    // a cache hit still answers when the budget is empty
    const warm = setup(
      {},
      {
        budget: (() => {
          let n = 0;
          return () => ++n <= 3;
        })(),
      }
    );
    expect(await warm.service.read(warm.request(), warm.observe)).toMatchObject(
      { ok: true }
    );
    expect(await warm.service.read(warm.request(), warm.observe)).toMatchObject(
      { ok: true, cache: "hit" }
    );
  });

  it("GitHub says its budget is out: the route pauses until the reset time and answers github_unavailable without calling GitHub", async () => {
    const resetAt = Math.floor(Date.parse("2026-11-11T20:00:10Z") / 1000) + 120;
    const t = setup({
      repositoryIsPrivate: vi.fn(
        async (): Promise<GithubRead<boolean | null>> => ({
          kind: "rate_limited",
          resetAt,
        })
      ),
    });
    expect(await t.service.read(t.request(), t.observe)).toEqual({
      ok: false,
      code: "github_unavailable",
    });
    expect(
      await t.service.read(t.request({ commentId: 5 }), t.observe)
    ).toEqual({ ok: false, code: "github_unavailable" });
    expect(t.reader.repositoryIsPrivate).toHaveBeenCalledTimes(1);
    t.advance(121_000);
    await t.service.read(t.request({ commentId: 6 }), t.observe);
    expect(t.reader.repositoryIsPrivate).toHaveBeenCalledTimes(2);
  });

  it("a shape the contract refuses from GitHub is a broken read (github_unavailable), never a signed fact", async () => {
    const t = setup({
      readIssueComment: vi.fn(async () =>
        ok<GithubIssueCommentRead | null>({
          ...COMMENT,
          createdAt: "yesterday",
        })
      ),
    });
    expect(await t.service.read(t.request(), t.observe)).toEqual({
      ok: false,
      code: "github_unavailable",
    });
  });

  it("returns at most 5 proof lines for this node", async () => {
    const lines = Array.from(
      { length: 8 },
      (_, i) =>
        `cogni-proof:v1:${NODE_ID}:33333333-3333-4333-8333-33333333333${i}:AAAAAAAAAAAAAAAAAAAAA${i}`
    );
    const t = setup({
      readIssueComment: vi.fn(async () =>
        ok<GithubIssueCommentRead | null>({
          ...COMMENT,
          body: lines.join("\n"),
        })
      ),
    });
    const out = await t.service.read(t.request(), t.observe);
    if (!out.ok) throw new Error("expected a signed answer");
    const claims = GithubCommentAttestationClaimsSchema.parse(
      (await jwtVerify(out.attestation, t.publicKey)).payload
    );
    expect(claims.comment?.proofLines).toEqual(lines.slice(0, 5));
  });
});
