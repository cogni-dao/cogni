// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/review/linked-node-review`
 * Purpose: Pin the pieces of a git-review of a CONNECTED node (task.5448): the signer and its claims, the JWKS
 *   serving both keys, the typed failure mapping, the run-scoped reader (no operator fallback), the logged
 *   transport, and the subject grounding that runs before any model call.
 * Scope: Pure units with fakes. No network, no GitHub, no Doltgres.
 * Invariants:
 *   - SIGN_PER_CALL: `iss` operator origin, `sub` git-review, `aud` urn:cogni:node:<target>, scope as asked, <= 300 s.
 *   - JWKS_SERVES_EACH_KEY: attestation and git-review keys each carry their own kid; one unset never hides the other.
 *   - NO_OPERATOR_FALLBACK: another node's subject never reaches the local capability.
 *   - FAIL_BEFORE_MODEL: a refused index read fails grounding with the typed code and reads nothing else.
 * Side-effects: none
 * Links: src/bootstrap/review/*.ts, src/adapters/server/ai/remote-knowledge-capability.ts, task.5448
 * @internal
 */

import {
  AI_EXECUTION_ERROR_CODES,
  AiExecutionError,
  type AiExecutionErrorCode,
} from "@cogni/ai-core";
import type { KnowledgeCapability } from "@cogni/ai-tools";
import { ed25519Thumbprint } from "@cogni-dao/agent-grants/service-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envHolder = vi.hoisted(() => ({
  value: {} as Record<string, string | undefined>,
}));
vi.mock("@/shared/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/env")>()),
  serverEnv: () => envHolder.value,
}));

import {
  createRemoteKnowledgeCapability,
  readIndexRows,
  remoteFailureToExecutionCode,
} from "@/adapters/server/ai/remote-knowledge-capability";
import { GET as jwksGet } from "@/app/.well-known/jwks.json/route";
import { executionErrorToHttpStatus } from "@/app/_facades/ai/execution-error-mapper";
import { createScopedKnowledgeCapability } from "@/bootstrap/capabilities/scoped-knowledge";
import {
  getGitReviewSigner,
  resetGitReviewSignerCache,
} from "@/bootstrap/review/git-review-signer";
import {
  assertionKid,
  createLoggedFetch,
  createRemoteReaderRegistry,
  remoteKnowledgeCapabilityFor,
  remoteRouteClass,
} from "@/bootstrap/review/remote-knowledge";
import {
  createSubjectGroundingLoader,
  readMissionFromRepoSpec,
} from "@/bootstrap/review/subject-grounding";
import type { RemoteKnowledgeReadPort } from "@/ports/remote-knowledge.port";

const SEED = "07".repeat(32);
const ISSUER = "https://cognidao.org";
const NODE_TEMPLATE = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const OPERATOR = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const TARGET = {
  alias: "node-template",
  nodeId: NODE_TEMPLATE,
  origin: "https://node-template-test.cognidao.org",
};

/** The failure the shared transport throws: matched by name and code. */
class RemoteKnowledgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RemoteKnowledgeError";
  }
}

function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

beforeEach(() => {
  envHolder.value = {};
  resetGitReviewSignerCache();
});

describe("git-review signer (task.5448)", () => {
  it("signs a short-lived assertion for the target node with the agreed claims", async () => {
    const result = await getGitReviewSigner({
      seedHex: SEED,
      appBaseUrl: `${ISSUER}/anything`,
    });
    if (!result.ok) throw new Error("signer expected");
    const header = await result.signer.authorizationHeader({
      service: "git-review",
      audienceNodeId: NODE_TEMPLATE,
      scope: "knowledge:read",
    });
    expect(header.startsWith("Bearer ")).toBe(true);
    const claims = claimsOf(header.slice(7));
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: "git-review",
      aud: `urn:cogni:node:${NODE_TEMPLATE}`,
      scope: "knowledge:read",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(300);
    expect(typeof claims.jti).toBe("string");
  });

  it("is built once per issuer and seed, and its kid is the RFC 7638 thumbprint", async () => {
    const a = await getGitReviewSigner({ seedHex: SEED, appBaseUrl: ISSUER });
    const b = await getGitReviewSigner({ seedHex: SEED, appBaseUrl: ISSUER });
    if (!a.ok || !b.ok) throw new Error("signer expected");
    expect(a.signer).toBe(b.signer);
    const [key] = a.signer.jwks().keys;
    expect(key?.kid).toBe(await ed25519Thumbprint(key?.x ?? ""));
  });

  it("fails closed with a typed reason, never a thrown error", async () => {
    expect(
      await getGitReviewSigner({ seedHex: undefined, appBaseUrl: ISSUER })
    ).toEqual({ ok: false, reason: "seed_missing" });
    expect(
      await getGitReviewSigner({ seedHex: "not-hex", appBaseUrl: ISSUER })
    ).toEqual({ ok: false, reason: "seed_invalid" });
    expect(
      await getGitReviewSigner({
        seedHex: SEED,
        appBaseUrl: "http://localhost:3000",
      })
    ).toEqual({ ok: false, reason: "issuer_invalid" });
  });
});

describe("/.well-known/jwks.json serves both keys (task.5448)", () => {
  const attestationSeed = Buffer.alloc(32, 9).toString("base64");

  async function keys(): Promise<Array<{ kid: string; x: string }>> {
    const body = (await (await jwksGet()).json()) as {
      keys: Array<{ kid: string; x: string }>;
    };
    return body.keys;
  }

  it("serves the attestation key AND the git-review key, each with its own kid", async () => {
    envHolder.value = {
      IDENTITY_ATTESTATION_PRIVATE_KEY: attestationSeed,
      GIT_REVIEW_SIGNING_SEED: SEED,
      APP_BASE_URL: ISSUER,
    };
    const served = await keys();
    expect(served).toHaveLength(2);
    expect(new Set(served.map((k) => k.kid)).size).toBe(2);
    expect(new Set(served.map((k) => k.x)).size).toBe(2);
    for (const key of served) {
      expect(key.kid).toBe(await ed25519Thumbprint(key.x));
      expect(key).not.toHaveProperty("d");
    }
  });

  it("still serves one key when the other is unset", async () => {
    envHolder.value = {
      IDENTITY_ATTESTATION_PRIVATE_KEY: attestationSeed,
      APP_BASE_URL: ISSUER,
    };
    expect(await keys()).toHaveLength(1);
    envHolder.value = { GIT_REVIEW_SIGNING_SEED: SEED, APP_BASE_URL: ISSUER };
    expect(await keys()).toHaveLength(1);
    envHolder.value = {};
    expect(await keys()).toEqual([]);
  });

  it("a malformed key serves nothing for itself and never hides the other", async () => {
    envHolder.value = {
      IDENTITY_ATTESTATION_PRIVATE_KEY: "short",
      GIT_REVIEW_SIGNING_SEED: SEED,
      APP_BASE_URL: ISSUER,
    };
    expect(await keys()).toHaveLength(1);
  });
});

describe("typed remote failures (task.5448)", () => {
  it("every remote code is a registered execution error code", () => {
    for (const code of [
      "remote_access_requested",
      "remote_policy_denied",
      "remote_unavailable",
    ]) {
      expect(AI_EXECUTION_ERROR_CODES).toContain(code);
    }
  });

  it.each([
    ["access_requested", "remote_access_requested"],
    ["policy_denied", "remote_policy_denied"],
    ["unavailable", "remote_unavailable"],
    ["invalid_id", "invalid_request"],
    ["unknown_alias", "internal"],
  ])("maps the transport code %s to %s", (code, expected) => {
    expect(remoteFailureToExecutionCode(new RemoteKnowledgeError(code))).toBe(
      expected
    );
  });

  it("does not map an ordinary error", () => {
    expect(remoteFailureToExecutionCode(new Error("boom"))).toBeUndefined();
  });

  it.each([
    ["remote_access_requested", 403],
    ["remote_policy_denied", 403],
    ["remote_unavailable", 503],
  ] as Array<
    [AiExecutionErrorCode, number]
  >)("answers %s as HTTP %i", (code, status) => {
    expect(executionErrorToHttpStatus(code)).toBe(status);
  });
});

describe("run-scoped knowledge (task.5448)", () => {
  function fakeCapability(label: string): KnowledgeCapability {
    return {
      search: vi.fn(async () => []),
      list: vi.fn(async () => []),
      get: vi.fn(async () => {
        throw new Error(`${label}.get`);
      }),
      write: vi.fn(async () => {
        throw new Error(`${label}.write`);
      }),
      listGoverningIndex: vi.fn(async () => []),
    };
  }

  it("with no subject, or the operator itself as subject, every call is the LOCAL capability", async () => {
    const local = fakeCapability("local");
    const remoteFor = vi.fn();
    for (const subject of [undefined, OPERATOR]) {
      const scoped = createScopedKnowledgeCapability({
        local,
        nodeId: OPERATOR,
        getSubjectNodeId: () => subject,
        remoteFor,
      });
      await scoped.list({ domain: "d" });
      await scoped.listGoverningIndex?.();
    }
    expect(local.list).toHaveBeenCalledTimes(2);
    expect(local.listGoverningIndex).toHaveBeenCalledTimes(2);
    expect(remoteFor).not.toHaveBeenCalled();
  });

  it("another node's subject is read remotely and NEVER touches the local capability", async () => {
    const local = fakeCapability("local");
    const remote = fakeCapability("remote");
    const scoped = createScopedKnowledgeCapability({
      local,
      nodeId: OPERATOR,
      getSubjectNodeId: () => NODE_TEMPLATE,
      remoteFor: () => remote,
    });
    await scoped.search({ domain: "d", query: "q" });
    await scoped.listGoverningIndex?.();
    await expect(scoped.get("x")).rejects.toThrow("remote.get");
    expect(remote.search).toHaveBeenCalledTimes(1);
    expect(local.search).not.toHaveBeenCalled();
    expect(local.get).not.toHaveBeenCalled();
    expect(local.listGoverningIndex).not.toHaveBeenCalled();
  });

  it("an unlisted subject throws; there is no operator fallback", async () => {
    const local = fakeCapability("local");
    const scoped = createScopedKnowledgeCapability({
      local,
      nodeId: OPERATOR,
      getSubjectNodeId: () => "99999999-9999-4999-8999-999999999999",
      remoteFor: (id) =>
        remoteKnowledgeCapabilityFor(id, { findTarget: () => undefined }),
    });
    await expect(scoped.list({ domain: "d" })).rejects.toThrow(
      "knowledge_subject_not_linked"
    );
    expect(local.list).not.toHaveBeenCalled();
  });

  it("the remote adapter is read-only: write throws", async () => {
    const port: RemoteKnowledgeReadPort = {
      originOf: () => TARGET.origin,
      get: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
    };
    const capability = createRemoteKnowledgeCapability(port, "node-template");
    await expect(
      capability.write({
        id: "x",
        domain: "d",
        title: "t",
        content: "c",
        sourceType: "human",
      })
    ).rejects.toThrow("knowledge_write_unavailable_for_linked_node");
  });

  it("the index read fails `unavailable` when the transport has no index method", async () => {
    const port: RemoteKnowledgeReadPort = {
      originOf: () => TARGET.origin,
      get: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
    };
    await expect(readIndexRows(port, "node-template")).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("remote transport registry (task.5448)", () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  beforeEach(() => {
    log.info.mockClear();
    log.warn.mockClear();
  });

  it("builds ONE transport per target and signs each call for that target's node", async () => {
    const factory = vi.fn((deps: { targets: unknown[] }) => {
      void deps;
      return {
        originOf: () => TARGET.origin,
        get: vi.fn(),
        list: vi.fn(),
        search: vi.fn(),
        index: vi.fn(),
      } satisfies RemoteKnowledgeReadPort;
    });
    const authorizationHeader = vi.fn(async () => "Bearer jwt");
    const registry = createRemoteReaderRegistry({
      factory: factory as never,
      authorizationHeader,
      log,
    });
    expect(registry.available(TARGET)).toBe(true);
    expect(registry.forTarget(TARGET)).toBe(registry.forTarget(TARGET));
    expect(factory).toHaveBeenCalledTimes(1);

    const deps = factory.mock.calls[0]?.[0] as unknown as {
      authorize: (t: typeof TARGET, scope: string) => Promise<string>;
    };
    await deps.authorize(TARGET, "knowledge:read");
    expect(authorizationHeader).toHaveBeenCalledWith({
      service: "git-review",
      audienceNodeId: NODE_TEMPLATE,
      scope: "knowledge:read",
    });
  });

  it("has no reader when the shared package carries no transport", () => {
    const registry = createRemoteReaderRegistry({
      factory: undefined,
      authorizationHeader: vi.fn(),
      log,
    });
    expect(registry.available(TARGET)).toBe(false);
    expect(() => registry.forTarget(TARGET)).toThrow(
      "remote_transport_unavailable"
    );
  });

  it("is not available when the built reader has no index (ai-tools 0.15 through 0.17)", () => {
    const factory = vi.fn(
      () =>
        ({
          originOf: () => TARGET.origin,
          get: vi.fn(),
          list: vi.fn(),
          search: vi.fn(),
        }) satisfies RemoteKnowledgeReadPort
    );
    const registry = createRemoteReaderRegistry({
      factory: factory as never,
      authorizationHeader: vi.fn(),
      log,
    });
    expect(registry.available(TARGET)).toBe(false);
  });

  it("is not available when building the reader throws", () => {
    const registry = createRemoteReaderRegistry({
      factory: (() => {
        throw new Error("boom");
      }) as never,
      authorizationHeader: vi.fn(),
      log,
    });
    expect(registry.available(TARGET)).toBe(false);
  });

  it("logs ONE review.remote_read per request: alias, route, status, kid; never a URL, id or token", async () => {
    const jwtHeader = Buffer.from(
      JSON.stringify({ alg: "EdDSA", kid: "kid-1" })
    ).toString("base64url");
    const token = `${jwtHeader}.e30.sig`;
    const base = vi.fn(async () => new Response("{}", { status: 403 }));
    const logged = createLoggedFetch(
      "node-template",
      log,
      base as unknown as typeof fetch
    );
    await logged(`${TARGET.origin}/api/v1/knowledge/secret-entry-id`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, message] = log.info.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toBe("review.remote_read");
    expect(fields).toMatchObject({
      event: "review.remote_read",
      alias: "node-template",
      route: "knowledge.get",
      status: 403,
      kid: "kid-1",
    });
    const text = JSON.stringify(log.info.mock.calls);
    expect(text).not.toContain(token);
    expect(text).not.toContain("secret-entry-id");
    expect(text).not.toContain(TARGET.origin);
  });

  it("classifies request routes and reads only the public kid", () => {
    expect(remoteRouteClass(`${TARGET.origin}/api/v1/knowledge?domain=a`)).toBe(
      "knowledge.list"
    );
    expect(remoteRouteClass(`${TARGET.origin}/api/v1/knowledge/index`)).toBe(
      "knowledge.index"
    );
    expect(
      remoteRouteClass(
        `${TARGET.origin}/api/v1/public/agent/service-enrollments`
      )
    ).toBe("enrollment");
    expect(assertionKid({ Authorization: "Bearer not-a-jwt" })).toBeUndefined();
    expect(assertionKid(undefined)).toBeUndefined();
  });
});

describe("subject grounding (task.5448)", () => {
  const SUBJECT = {
    nodeId: NODE_TEMPLATE,
    owner: "cogni-dao",
    repo: "node-template",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
  };
  const SPEC = `node_id: ${NODE_TEMPLATE}\nintent:\n  mission: Build the template.\n`;
  const INDEX = [
    {
      id: "alpha-rule",
      domain: "method",
      entryType: "rule",
      useWhen: "always",
    },
    {
      id: "template-architect",
      domain: "meta",
      entryType: "guide",
      useWhen: "any change",
    },
  ];

  function loaderWith(
    port: Partial<RemoteKnowledgeReadPort>,
    readCommitFile = vi.fn(async () => SPEC as string | null)
  ) {
    const reader: RemoteKnowledgeReadPort = {
      originOf: () => TARGET.origin,
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      ...port,
    };
    const warn = vi.fn();
    const loader = createSubjectGroundingLoader({
      readCommitFile,
      operatorBuildSha: "operator-sha",
      log: { warn },
      findTarget: (id) => (id === NODE_TEMPLATE ? TARGET : undefined),
      registry: { available: () => true, forTarget: () => reader },
    });
    return { loader, readCommitFile, warn, reader };
  }

  it("takes index, architect (id from the index), origin and mission from the SUBJECT", async () => {
    const { loader, readCommitFile, reader } = loaderWith({
      index: vi.fn(async () => INDEX),
      get: vi.fn(async () => ({ content: "ARCHITECT BODY" }) as never),
    });
    const grounding = await loader(SUBJECT);
    expect(grounding.nodeId).toBe(NODE_TEMPLATE);
    expect(grounding.origin).toBe(TARGET.origin);
    expect(grounding.governingIndex.map((r) => r.id)).toEqual([
      "alpha-rule",
      "template-architect",
    ]);
    expect(grounding.architect).toEqual({
      id: "template-architect",
      content: "ARCHITECT BODY",
      sourceRef: "hub:node-template:template-architect",
    });
    expect(reader.get).toHaveBeenCalledWith(
      "node-template",
      "template-architect"
    );
    expect(grounding.mission).toEqual({
      content: "Build the template.",
      sourceRef: `cogni-dao/node-template@${"b".repeat(12)}:.cogni/repo-spec.yaml#intent.mission`,
      buildSha: "operator-sha",
    });
    expect(readCommitFile).toHaveBeenCalledWith(
      expect.objectContaining({
        commitSha: SUBJECT.baseSha,
        path: ".cogni/repo-spec.yaml",
        owner: "cogni-dao",
        repo: "node-template",
      })
    );
  });

  it.each([
    ["access_requested", "remote_access_requested"],
    ["policy_denied", "remote_policy_denied"],
    ["unavailable", "remote_unavailable"],
  ])("a refused index read (%s) fails with %s before anything else is read", async (code, expected) => {
    const { loader, readCommitFile } = loaderWith({
      index: vi.fn(async () => {
        throw new RemoteKnowledgeError(code);
      }),
    });
    await expect(loader(SUBJECT)).rejects.toMatchObject({
      name: "AiExecutionError",
      code: expected,
    });
    expect(readCommitFile).not.toHaveBeenCalled();
  });

  it("a transport with no index method fails `remote_unavailable`", async () => {
    const { loader } = loaderWith({});
    await expect(loader(SUBJECT)).rejects.toMatchObject({
      code: "remote_unavailable",
    });
  });

  it("a refused architect read fails the run with the typed code (never silently omitted)", async () => {
    const { loader } = loaderWith({
      index: vi.fn(async () => INDEX),
      get: vi.fn(async () => {
        throw new RemoteKnowledgeError("policy_denied");
      }),
    });
    await expect(loader(SUBJECT)).rejects.toMatchObject({
      code: "remote_policy_denied",
    });
  });

  it("no unique architect entry proceeds without one, with a structured warn", async () => {
    const { loader, warn } = loaderWith({
      index: vi.fn(async () => [INDEX[0] as (typeof INDEX)[number]]),
    });
    const grounding = await loader(SUBJECT);
    expect(grounding.architect).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no_unique_architect_entry" }),
      expect.any(String)
    );
  });

  it("refuses a repo-spec of another node, a missing repo-spec and a missing mission", async () => {
    const index = vi.fn(async () => INDEX);
    const wrongNode = loaderWith(
      { index },
      vi.fn(async () => `node_id: ${OPERATOR}\nintent:\n  mission: x\n`)
    );
    await expect(wrongNode.loader(SUBJECT)).rejects.toThrow(
      "subject_repo_spec_node_mismatch"
    );
    const missing = loaderWith(
      { index },
      vi.fn(async () => null)
    );
    await expect(missing.loader(SUBJECT)).rejects.toThrow(
      "subject_repo_spec_unavailable"
    );
    const noMission = loaderWith(
      { index },
      vi.fn(async () => `node_id: ${NODE_TEMPLATE}\n`)
    );
    await expect(noMission.loader(SUBJECT)).rejects.toThrow(
      "subject_mission_unavailable"
    );
  });

  it("an unlisted subject is refused, and the failure is an AiExecutionError", async () => {
    const { loader } = loaderWith({ index: vi.fn(async () => INDEX) });
    const rejection = loader({ ...SUBJECT, nodeId: OPERATOR });
    await expect(rejection).rejects.toBeInstanceOf(AiExecutionError);
    await expect(rejection).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("reads the mission and node id from a repo-spec document", () => {
    expect(readMissionFromRepoSpec(SPEC)).toEqual({
      nodeId: NODE_TEMPLATE,
      mission: "Build the template.",
    });
    expect(readMissionFromRepoSpec("- a\n- b\n")).toEqual({
      nodeId: undefined,
      mission: undefined,
    });
  });
});
