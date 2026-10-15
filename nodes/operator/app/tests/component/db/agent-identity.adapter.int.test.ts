// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres proof for durable, node-local agent credentials (task.5252). */
import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleAgentIdentityAdapter } from "@/adapters/server/identity/agent-identity.adapter";
import type { AgentIdentityError } from "@/ports";
import {
  actors,
  agentCredentials,
  agentRecoveryGrants,
  agentSpawnGrants,
  billingAccounts,
  users,
} from "@/shared/db/schema";

describe("DrizzleAgentIdentityAdapter (Component)", () => {
  const db = getSeedDb();
  const nodeId = `node-${randomUUID()}`;
  const userId = randomUUID();
  const billingAccountId = randomUUID();
  let now = new Date("2026-10-09T00:00:00.000Z");
  const identity = new DrizzleAgentIdentityAdapter(
    db,
    nodeId,
    "component-agent-issuance-key-at-least-32-bytes",
    () => now
  );

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      name: "Agent credential steward",
      walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
    });
    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: userId,
      balanceCredits: 0n,
    });
  });

  afterAll(async () => {
    await db.delete(agentRecoveryGrants);
    await db.delete(agentCredentials);
    await db.delete(agentSpawnGrants);
  });

  async function spawn(name = "test-agent") {
    const grant = await identity.createSpawnGrant({
      issuerUserId: userId,
      name,
      idempotencyKey: randomUUID(),
    });
    return identity.redeemSpawnGrant(grant.token);
  }

  it("rejects an unissued grant without creating an actor or credential", async () => {
    const beforeActors = await db.select().from(actors);
    const beforeCredentials = await db.select().from(agentCredentials);

    await expect(
      identity.redeemSpawnGrant("cogni_ag_sg_v1_not-issued")
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "invalid_grant",
    });

    expect(await db.select().from(actors)).toHaveLength(beforeActors.length);
    expect(await db.select().from(agentCredentials)).toHaveLength(
      beforeCredentials.length
    );
  });

  it("caps outstanding spawn grants per issuer", async () => {
    const idempotencyKey = randomUUID();
    const first = await identity.createSpawnGrant({
      issuerUserId: userId,
      name: "cap-0",
      idempotencyKey,
    });
    for (let index = 1; index < 5; index += 1) {
      await identity.createSpawnGrant({
        issuerUserId: userId,
        name: `cap-${index}`,
        idempotencyKey: randomUUID(),
      });
    }

    await expect(
      identity.createSpawnGrant({
        issuerUserId: userId,
        name: "cap-0",
        idempotencyKey,
      })
    ).resolves.toEqual(first);
    await expect(
      identity.createSpawnGrant({
        issuerUserId: userId,
        name: "different-request",
        idempotencyKey,
      })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "invalid_grant",
    });

    await expect(
      identity.createSpawnGrant({
        issuerUserId: userId,
        name: "over-cap",
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "grant_limit",
    });

    await db
      .delete(agentSpawnGrants)
      .where(eq(agentSpawnGrants.status, "pending"));
  });

  it("enforces the active-agent cap at grant issuance and redemption", async () => {
    const issuedBeforeFull = await identity.createSpawnGrant({
      issuerUserId: userId,
      name: "issued-before-full",
      idempotencyKey: randomUUID(),
    });
    const cappedActorIds = Array.from({ length: 25 }, () => randomUUID());
    await db.insert(actors).values(
      cappedActorIds.map((id, index) => ({
        id,
        kind: "agent" as const,
        displayName: `cap-fixture-${index}`,
        billingAccountId,
      }))
    );

    await expect(
      identity.createSpawnGrant({
        issuerUserId: userId,
        name: "over-active-cap",
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "spawn_limit",
    });
    await expect(
      identity.redeemSpawnGrant(issuedBeforeFull.token)
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "spawn_limit",
    });

    await db.delete(actors).where(inArray(actors.id, cappedActorIds));
    await db
      .delete(agentSpawnGrants)
      .where(eq(agentSpawnGrants.id, issuedBeforeFull.grantId));
  });

  it("redeems a grant concurrently into exactly one stable actor and credential", async () => {
    const grant = await identity.createSpawnGrant({
      issuerUserId: userId,
      name: "parallel-agent",
      idempotencyKey: randomUUID(),
    });
    const results = await Promise.all(
      Array.from({ length: 2 }, () => identity.redeemSpawnGrant(grant.token))
    );

    expect(new Set(results.map((result) => result.actorId))).toHaveLength(1);
    expect(new Set(results.map((result) => result.credentialId))).toHaveLength(
      1
    );
    expect(new Set(results.map((result) => result.apiKey))).toHaveLength(1);
    const [row] = await db
      .select()
      .from(agentSpawnGrants)
      .where(eq(agentSpawnGrants.id, grant.grantId));
    expect(row).toMatchObject({
      status: "redeemed",
      redeemedActorId: results[0]?.actorId,
    });
  });

  it("never re-emits spawn credential material after grant expiry", async () => {
    const grant = await identity.createSpawnGrant({
      issuerUserId: userId,
      name: "lost-spawn-response",
      idempotencyKey: randomUUID(),
    });
    const first = await identity.redeemSpawnGrant(grant.token);
    const actorsBeforeReplay = await db.select().from(actors);
    const credentialsBeforeReplay = await db.select().from(agentCredentials);
    now = new Date(new Date(grant.expiresAt).getTime() + 1);

    await expect(identity.redeemSpawnGrant(grant.token)).rejects.toMatchObject<
      Partial<AgentIdentityError>
    >({
      code: "grant_already_redeemed",
    });
    expect(await db.select().from(actors)).toHaveLength(
      actorsBeforeReplay.length
    );
    expect(await db.select().from(agentCredentials)).toHaveLength(
      credentialsBeforeReplay.length
    );
    await expect(identity.authenticate(first.apiKey)).resolves.toMatchObject({
      principal: { actorId: first.actorId },
    });

    now = new Date("2026-10-09T00:00:00.000Z");
  });

  it("authenticates only on the issuing node and fails closed on a database error", async () => {
    const credential = await spawn("node-local-agent");
    await expect(
      identity.authenticate(credential.apiKey)
    ).resolves.toMatchObject({
      principal: {
        principalId: `agent:${nodeId}/${credential.actorId}`,
        actorId: credential.actorId,
      },
    });

    const otherNode = new DrizzleAgentIdentityAdapter(
      db,
      `other-${nodeId}`,
      "component-agent-issuance-key-at-least-32-bytes",
      () => now
    );
    await expect(otherNode.authenticate(credential.apiKey)).resolves.toBeNull();

    const unavailable = new DrizzleAgentIdentityAdapter(
      {
        select: () => {
          throw new Error("database unavailable");
        },
      } as never,
      nodeId,
      "component-agent-issuance-key-at-least-32-bytes",
      () => now
    );
    await expect(unavailable.authenticate(credential.apiKey)).rejects.toThrow(
      "database unavailable"
    );
  });

  it("audiences grant derivation to the node even when auth roots and surrogates match", async () => {
    const idempotencyKey = randomUUID();
    const first = await identity.createSpawnGrant({
      issuerUserId: userId,
      name: "same-fixture-agent",
      idempotencyKey,
    });
    await db
      .delete(agentSpawnGrants)
      .where(eq(agentSpawnGrants.id, first.grantId));

    const otherNode = new DrizzleAgentIdentityAdapter(
      db,
      randomUUID(),
      "component-agent-issuance-key-at-least-32-bytes",
      () => now
    );
    const second = await otherNode.createSpawnGrant({
      issuerUserId: userId,
      name: "same-fixture-agent",
      idempotencyKey,
    });

    expect(second.token).not.toBe(first.token);
    await expect(identity.redeemSpawnGrant(second.token)).rejects.toMatchObject<
      Partial<AgentIdentityError>
    >({ code: "invalid_grant" });

    await db
      .delete(agentSpawnGrants)
      .where(eq(agentSpawnGrants.id, second.grantId));
  });

  it("keeps the predecessor active until confirm, then revokes it atomically", async () => {
    const current = await spawn("rotating-agent");
    const idempotencyKey = randomUUID();
    const [first, retry] = await Promise.all([
      identity.rotate({ token: current.apiKey, idempotencyKey }),
      identity.rotate({ token: current.apiKey, idempotencyKey }),
    ]);

    expect(retry).toEqual(first);
    await expect(identity.authenticate(current.apiKey)).resolves.not.toBeNull();
    await expect(identity.authenticate(first.apiKey)).resolves.toBeNull();

    const confirmed = await identity.confirm(first.apiKey);
    expect(confirmed.principal.actorId).toBe(current.actorId);
    await expect(identity.authenticate(current.apiKey)).resolves.toBeNull();
    await expect(identity.authenticate(first.apiKey)).resolves.toMatchObject({
      principal: { actorId: current.actorId },
    });

    const [predecessor] = await db
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.id, current.credentialId));
    expect(predecessor).toMatchObject({
      status: "revoked",
      replacedByCredentialId: first.credentialId,
    });
  });

  it("replays the same rotation safely after its pending window expires", async () => {
    const current = await spawn("lost-rotation-response");
    const idempotencyKey = randomUUID();
    const first = await identity.rotate({
      token: current.apiKey,
      idempotencyKey,
    });
    now = new Date(new Date(first.pendingExpiresAt).getTime() + 1);

    const replay = await identity.rotate({
      token: current.apiKey,
      idempotencyKey,
    });

    expect(replay.credentialId).toBe(first.credentialId);
    expect(replay.apiKey).toBe(first.apiKey);
    expect(new Date(replay.pendingExpiresAt).getTime()).toBeGreaterThan(
      new Date(first.pendingExpiresAt).getTime()
    );
    await expect(identity.confirm(replay.apiKey)).resolves.toMatchObject({
      principal: { actorId: current.actorId },
    });

    now = new Date("2026-10-09T00:00:00.000Z");
  });

  it("permits rotation, but not data access, during renew-only grace", async () => {
    const current = await spawn("grace-agent");
    now = new Date(current.authenticateUntil);
    now = new Date(now.getTime() + 1);

    await expect(
      identity.authenticate(current.apiKey, "data")
    ).resolves.toBeNull();
    await expect(
      identity.authenticate(current.apiKey, "renew")
    ).resolves.toMatchObject({
      access: "renew_only",
      principal: { actorId: current.actorId },
    });
    const pending = await identity.rotate({
      token: current.apiKey,
      idempotencyKey: randomUUID(),
    });
    expect(pending.actorId).toBe(current.actorId);

    now = new Date("2026-10-09T00:00:00.000Z");
  });

  it("recovers a credential onto the same accepted agent actor", async () => {
    const current = await spawn("recoverable-agent");
    const pending = await identity.rotate({
      token: current.apiKey,
      idempotencyKey: randomUUID(),
    });
    const grant = await identity.createRecoveryGrant({
      issuerUserId: userId,
      actorId: current.actorId,
      idempotencyKey: randomUUID(),
    });
    const [first, retry] = await Promise.all([
      identity.recover(grant.token),
      identity.recover(grant.token),
    ]);

    expect(first.actorId).toBe(current.actorId);
    expect(retry).toEqual(first);
    await expect(identity.authenticate(current.apiKey)).resolves.toBeNull();
    await expect(identity.confirm(pending.apiKey)).rejects.toMatchObject<
      Partial<AgentIdentityError>
    >({ code: "invalid_credential" });
    await expect(identity.authenticate(first.apiKey)).resolves.toMatchObject({
      principal: { actorId: current.actorId },
    });
  });

  it("caps outstanding recovery grants in the shared issuer grant budget", async () => {
    const current = await spawn("recovery-cap-agent");
    const other = await spawn("recovery-cap-other-agent");
    const idempotencyKey = randomUUID();
    const first = await identity.createRecoveryGrant({
      issuerUserId: userId,
      actorId: current.actorId,
      idempotencyKey,
    });
    for (let index = 1; index < 5; index += 1) {
      await identity.createRecoveryGrant({
        issuerUserId: userId,
        actorId: current.actorId,
        idempotencyKey: randomUUID(),
      });
    }

    await expect(
      identity.createRecoveryGrant({
        issuerUserId: userId,
        actorId: current.actorId,
        idempotencyKey,
      })
    ).resolves.toEqual(first);

    await expect(
      identity.createRecoveryGrant({
        issuerUserId: userId,
        actorId: other.actorId,
        idempotencyKey,
      })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "invalid_grant",
    });

    await expect(
      identity.createRecoveryGrant({
        issuerUserId: userId,
        actorId: current.actorId,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "grant_limit",
    });

    await db
      .delete(agentRecoveryGrants)
      .where(eq(agentRecoveryGrants.status, "pending"));
  });

  it("never re-emits recovered credential material after grant expiry", async () => {
    const current = await spawn("lost-recovery-response");
    const grant = await identity.createRecoveryGrant({
      issuerUserId: userId,
      actorId: current.actorId,
      idempotencyKey: randomUUID(),
    });
    const first = await identity.recover(grant.token);
    const actorsBeforeReplay = await db.select().from(actors);
    const credentialsBeforeReplay = await db.select().from(agentCredentials);
    now = new Date(new Date(grant.expiresAt).getTime() + 1);

    await expect(identity.recover(grant.token)).rejects.toMatchObject<
      Partial<AgentIdentityError>
    >({ code: "grant_already_redeemed" });
    expect(await db.select().from(actors)).toHaveLength(
      actorsBeforeReplay.length
    );
    expect(await db.select().from(agentCredentials)).toHaveLength(
      credentialsBeforeReplay.length
    );
    await expect(identity.authenticate(current.apiKey)).resolves.toBeNull();
    await expect(identity.authenticate(first.apiKey)).resolves.toMatchObject({
      principal: { actorId: current.actorId },
    });

    now = new Date("2026-10-09T00:00:00.000Z");
  });

  it("upgrades a legacy user link idempotently without changing billing", async () => {
    const input = {
      legacyToken: "cogni_ag_sk_v1_component-legacy-token",
      legacyUserId: userId,
      displayName: "legacy-agent",
      idempotencyKey: randomUUID(),
    };
    const first = await identity.upgradeLegacy(input);
    const retry = await identity.upgradeLegacy(input);

    expect(retry).toEqual(first);
    expect(first.billingAccountId).toBe(billingAccountId);
    expect(first.principalId).toBe(`agent:${nodeId}/${first.actorId}`);
    await expect(identity.authenticate(first.apiKey)).resolves.toMatchObject({
      principal: {
        actorId: first.actorId,
        legacyUserId: userId,
        billingAccountId,
      },
    });
  });
});
