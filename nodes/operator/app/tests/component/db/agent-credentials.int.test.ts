// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-credentials.int.test`
 * Purpose: The v2 agent key store against real Postgres with migration 0063 applied (story.5156). Runs the package's OWN conformance suite
 *   (`runCredentialConformance`, SUITE_GATES_RELEASE) over the real SQL, then the rows only SQL can prove: the RLS wall, the
 *   external-principal trigger, hash uniqueness, the renew check and the same-users.id upgrade.
 * Scope: `@cogni-dao/agent-grants/credentials` + migration 0063; does not exercise HTTP. Port of node-template's agent-credentials.int.test.ts
 *   (the internal-principal probe seeds its own row; the operator has no NODE_AI_PRINCIPAL_USER_ID seed).
 * Invariants:
 *   - SERVICE_ROLE_ONLY: the app role sees no `agent_credentials` row.
 *   - TOKEN_HASH_ONLY: only the sha256 of a key is stored.
 *   - STATE_IS_DERIVED: moving a timestamp moves the state; nothing else is written.
 * Side-effects: IO (testcontainers Postgres)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS; DATABASE_URL = app role with FORCE RLS.
 * Links: nodes/operator/app/src/adapters/server/db/migrations/0063_brainy_tempest.sql, https://cognidao.org/work/items/story.5156
 */

import { randomUUID } from "node:crypto";
import { runCredentialConformance } from "@cogni-dao/agent-grants/conformance";
import {
  type CredentialSql,
  confirmCredential,
  createPostgresCredentialStore,
  hashAgentKey,
  type MintedKey,
  rotateCredential,
  upgradeFromV1,
  verifyBearer,
} from "@cogni-dao/agent-grants/credentials";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("agent credentials (real Postgres)", () => {
  let service: Sql;
  let app: Sql;
  const users: string[] = [];
  const makeUser = async () => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`cred-${id.slice(0, 6)}`})`;
    users.push(id);
    return id;
  };
  const store = () =>
    createPostgresCredentialStore(service as unknown as CredentialSql);
  const ok = (m: MintedKey) => {
    if (!m.ok) throw new Error(`refused: ${m.reason}`);
    return m;
  };
  const stateOf = async (credentialId: string) =>
    (
      await service`SELECT agent_credential_state(c) AS state FROM agent_credentials c WHERE c.id = ${credentialId}`
    )[0]?.state;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL)
      throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 8 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe(
      "DELETE FROM agent_credentials WHERE user_id = ANY($1)",
      [users]
    );
    await service?.unsafe(
      "DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)",
      [users]
    );
    await service?.unsafe(
      "DELETE FROM agent_principals WHERE user_id = ANY($1)",
      [users]
    );
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [
      users,
    ]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  // The package's own conformance rows over the real SQL adapter. Users are real rows; timestamps move with UPDATE
  // because the database clock keeps its own time.
  runCredentialConformance({
    describe,
    it,
    expect,
    async setup(facts) {
      const ids: Record<string, string> = {};
      for (const [name, f] of Object.entries(facts)) {
        const id = await makeUser();
        ids[name] = id;
        const admin = f.roles ? await makeUser() : null;
        if (f.wallet)
          await service`UPDATE users SET wallet_address = ${`0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`} WHERE id = ${id}`;
        if (f.internal)
          await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', ${`conf-${id}`}, ${id})`;
        if (f.roles)
          await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${id}, 'probe:scope', ${admin}, now())`;
        if (f.github)
          await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'github', ${`gh-${randomUUID()}`})`;
      }
      return { store: store(), ids };
    },
    async age(credentialId, to) {
      if (to === "pending_expired")
        await service`UPDATE agent_credentials SET pending_expires_at = now() - interval '1 second' WHERE id = ${credentialId}`;
      else if (to === "renew_only")
        await service`UPDATE agent_credentials SET expires_at = now() - interval '1 hour', renew_until = now() + interval '1 day' WHERE id = ${credentialId}`;
      else
        await service`UPDATE agent_credentials SET expires_at = now() - interval '2 hour', renew_until = now() - interval '1 minute' WHERE id = ${credentialId}`;
    },
    broken: () =>
      createPostgresCredentialStore((async () => {
        throw new Error("db down");
      }) as unknown as CredentialSql),
    storedHash: async (credentialId) =>
      (
        await service`SELECT token_hash FROM agent_credentials WHERE id = ${credentialId}`
      )[0]?.token_hash ?? null,
    liveSuccessors: async (predecessorId) =>
      (
        await service`SELECT count(*)::int AS n FROM agent_credentials WHERE predecessor_id = ${predecessorId} AND confirmed_at IS NULL AND revoked_at IS NULL`
      )[0]?.n ?? 0,
  });

  describe("schema (rows only SQL can prove)", () => {
    it("the app role sees no credential row (FORCE RLS, no policy) and cannot write one", async () => {
      const user = await makeUser();
      ok(await upgradeFromV1(store(), { userId: user }));
      expect(await app`SELECT 1 FROM agent_credentials`).toHaveLength(0);
      await expect(
        app`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, 'x', 'rotation', now(), now() + interval '1 day')`
      ).rejects.toThrow();
    });

    it("only a user with an EXTERNAL agent principal may hold a credential (trigger)", async () => {
      const plain = await makeUser();
      const internal = await makeUser();
      await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', ${`int-${internal}`}, ${internal})`;
      const insert = (userId: string) =>
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${userId}, ${randomUUID()}, 'legacy_upgrade', now() + interval '1 day', now() + interval '2 day')`;
      await expect(insert(plain)).rejects.toThrow(
        /requires an external agent principal/
      );
      await expect(insert(internal)).rejects.toThrow(
        /requires an external agent principal/
      );
    });

    it("a duplicate hash is refused, and renew_until must pass expires_at", async () => {
      const user = await makeUser();
      const key = ok(await upgradeFromV1(store(), { userId: user }));
      await expect(
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, ${await hashAgentKey(key.apiKey)}, 'rotation', now(), now() + interval '1 day')`
      ).rejects.toThrow(/agent_credentials_token_hash_unique/);
      await expect(
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, ${randomUUID()}, 'rotation', now() + interval '2 day', now() + interval '1 day')`
      ).rejects.toThrow(/agent_credentials_renew_after_expiry/);
    });

    it("the state function derives from timestamps alone", async () => {
      const key = ok(
        await upgradeFromV1(store(), { userId: await makeUser() })
      );
      expect(await stateOf(key.credentialId)).toBe("pending");
      await confirmCredential(store(), { credentialId: key.credentialId });
      expect(await stateOf(key.credentialId)).toBe("active");
      expect(await verifyBearer(store(), key.apiKey)).toMatchObject({
        ok: true,
      });
    });

    it("upgrade writes an external principal on the SAME users.id and creates no second user", async () => {
      const user = await makeUser();
      const before = (await service`SELECT count(*)::int AS n FROM users`)[0]
        ?.n;
      const key = ok(await upgradeFromV1(store(), { userId: user }));
      expect(key.userId).toBe(user);
      expect((await service`SELECT count(*)::int AS n FROM users`)[0]?.n).toBe(
        before
      );
      expect(
        await service`SELECT kind FROM agent_principals WHERE user_id = ${user}`
      ).toEqual([expect.objectContaining({ kind: "external" })]);
    });

    it("confirm refuses when the predecessor was revoked meanwhile (409 predecessor_revoked)", async () => {
      const user = await makeUser();
      const old = ok(await upgradeFromV1(store(), { userId: user }));
      await confirmCredential(store(), { credentialId: old.credentialId });
      const next = ok(
        await rotateCredential(store(), { credentialId: old.credentialId })
      );
      await service`UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'probe' WHERE id = ${old.credentialId}`;
      expect(
        await confirmCredential(store(), { credentialId: next.credentialId })
      ).toEqual({ ok: false, reason: "predecessor_revoked" });
    });

    it("the wallet-binding trigger refuses a wallet for any agent principal (AGENTS_HOLD_NO_WALLET)", async () => {
      const user = await makeUser();
      ok(await upgradeFromV1(store(), { userId: user }));
      await expect(
        service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${user}, 'wallet', ${`0x${randomUUID().replaceAll("-", "").slice(0, 40)}`})`
      ).rejects.toThrow(/cannot bind a wallet/);
    });
  });
});
