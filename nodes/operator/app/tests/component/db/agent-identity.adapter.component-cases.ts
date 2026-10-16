// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real-Postgres proof for durable, node-local agent credentials (task.5252).
 * Imported by the RLS adapter wiring component entrypoint so both suites share
 * one worker and stay within the service role's production-shaped connection budget.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleAgentIdentityAdapter } from "@/adapters/server/identity/agent-identity.adapter";
import type { AgentIdentityError } from "@/ports";
import {
  actorBindings,
  actors,
  agentCredentials,
  agentRecoveryGrants,
  agentSpawnGrants,
  billingAccounts,
  existingAgentClaims,
  userBindings,
  users,
  virtualKeys,
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
      authorizationOwnerBootstrappedAt: now,
    });
  });

  afterAll(async () => {
    await db.delete(existingAgentClaims);
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

  async function createLegacyFixture(label: string) {
    const legacyUserId = randomUUID();
    const legacyBillingAccountId = randomUUID();
    await db.insert(users).values({
      id: legacyUserId,
      name: label,
      walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
    });
    await db.insert(billingAccounts).values({
      id: legacyBillingAccountId,
      ownerUserId: legacyUserId,
      balanceCredits: 0n,
      authorizationOwnerBootstrappedAt: now,
    });
    return { legacyUserId, legacyBillingAccountId };
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

  it("rejects recovery after accepted stewardship changes", async () => {
    const current = await spawn("stewardship-change-agent");
    const grant = await identity.createRecoveryGrant({
      issuerUserId: userId,
      actorId: current.actorId,
      idempotencyKey: randomUUID(),
    });
    const replacementUserId = randomUUID();
    const replacementBillingAccountId = randomUUID();
    await db.insert(users).values({
      id: replacementUserId,
      name: "Replacement steward",
      walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
    });
    await db.insert(billingAccounts).values({
      id: replacementBillingAccountId,
      ownerUserId: replacementUserId,
      balanceCredits: 0n,
      authorizationOwnerBootstrappedAt: now,
    });
    await identity.createSpawnGrant({
      issuerUserId: replacementUserId,
      name: "replacement-steward-bootstrap",
      idempotencyKey: randomUUID(),
    });
    const [replacementSteward] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.userId, replacementUserId))
      .limit(1);
    if (!replacementSteward) throw new Error("replacement steward missing");
    await db
      .update(actors)
      .set({ parentActorId: replacementSteward.id })
      .where(eq(actors.id, current.actorId));

    await expect(identity.recover(grant.token)).rejects.toMatchObject<
      Partial<AgentIdentityError>
    >({ code: "invalid_grant" });
    await expect(identity.authenticate(current.apiKey)).resolves.toMatchObject({
      principal: { actorId: current.actorId },
    });
  });

  it("claims an existing AI only after both human proposal and AI acceptance", async () => {
    const actorId = randomUUID();
    const externalId = `github-${randomUUID()}`;
    await db.insert(userBindings).values({
      id: randomUUID(),
      userId,
      provider: "github",
      externalId,
      providerLogin: "existing-ai",
    });
    await db.insert(actors).values({
      id: actorId,
      kind: "agent",
      displayName: "existing-ai",
      billingAccountId,
    });
    const claim = await identity.createExistingAgentClaim({
      stewardUserId: userId,
      actorId,
      provider: "github",
      externalId,
      providerLogin: "existing-ai",
      attestationJti: randomUUID(),
      attestationEvidence: { source: "component-test" },
      attestationExpiresAt: new Date(now.getTime() + 60_000),
      idempotencyKey: randomUUID(),
    });
    const [beforeAcceptance] = await db
      .select({ parentActorId: actors.parentActorId })
      .from(actors)
      .where(eq(actors.id, actorId));
    expect(beforeAcceptance?.parentActorId).toBeNull();

    const accepted = await identity.acceptExistingAgentClaim({
      actorId,
      claimId: claim.claimId,
    });
    expect(accepted.status).toBe("accepted");
    const [afterAcceptance] = await db
      .select({ parentActorId: actors.parentActorId })
      .from(actors)
      .where(eq(actors.id, actorId));
    expect(afterAcceptance?.parentActorId).not.toBeNull();
    const [binding] = await db
      .select({ actorId: actorBindings.actorId })
      .from(actorBindings)
      .where(eq(actorBindings.externalId, externalId));
    expect(binding?.actorId).toBe(actorId);
    const legacyProjection = await db
      .select({ id: userBindings.id })
      .from(userBindings)
      .where(eq(userBindings.externalId, externalId));
    expect(legacyProjection).toEqual([]);
  });

  it("suspends an agent and releases its active-agent capacity", async () => {
    const stewardUserId = randomUUID();
    const accountId = randomUUID();
    await db.insert(users).values({
      id: stewardUserId,
      name: "Capacity steward",
      walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
    });
    await db.insert(billingAccounts).values({
      id: accountId,
      ownerUserId: stewardUserId,
      balanceCredits: 0n,
      authorizationOwnerBootstrappedAt: now,
    });
    const dedicatedIdentity = new DrizzleAgentIdentityAdapter(
      db,
      nodeId,
      "component-agent-issuance-key-at-least-32-bytes",
      () => now
    );
    const firstGrant = await dedicatedIdentity.createSpawnGrant({
      issuerUserId: stewardUserId,
      name: "suspend-for-capacity",
      idempotencyKey: randomUUID(),
    });
    const first = await dedicatedIdentity.redeemSpawnGrant(firstGrant.token);
    const recovery = await dedicatedIdentity.createRecoveryGrant({
      issuerUserId: stewardUserId,
      actorId: first.actorId,
      idempotencyKey: randomUUID(),
    });
    const fillers = Array.from({ length: 24 }, () => randomUUID());
    await db.insert(actors).values(
      fillers.map((id, index) => ({
        id,
        kind: "agent" as const,
        displayName: `capacity-fixture-${index}`,
        billingAccountId: accountId,
      }))
    );
    await expect(
      dedicatedIdentity.createSpawnGrant({
        issuerUserId: stewardUserId,
        name: "blocked-at-cap",
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "spawn_limit",
    });

    await dedicatedIdentity.suspendAgent({
      stewardUserId,
      actorId: first.actorId,
      reason: "capacity release proof",
    });
    await expect(
      dedicatedIdentity.authenticate(first.apiKey)
    ).resolves.toBeNull();
    await expect(
      dedicatedIdentity.createSpawnGrant({
        issuerUserId: stewardUserId,
        name: "allowed-after-suspension",
        idempotencyKey: randomUUID(),
      })
    ).resolves.toMatchObject({ token: expect.any(String) });
    await expect(
      dedicatedIdentity.recover(recovery.token)
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "invalid_grant",
    });
  });

  it("backfills a default virtual key for an existing keyless account", async () => {
    const existingUserId = randomUUID();
    const existingAccountId = randomUUID();
    await db.insert(users).values({
      id: existingUserId,
      name: "Existing keyless account",
      walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
    });
    await db.insert(billingAccounts).values({
      id: existingAccountId,
      ownerUserId: existingUserId,
      balanceCredits: 0n,
    });
    const migration = readFileSync(
      new URL(
        "../../../src/adapters/server/db/migrations/0057_living_amphibian.sql",
        import.meta.url
      ),
      "utf8"
    );
    const backfill = migration.match(
      /INSERT INTO "virtual_keys"[\s\S]*?;(?=--> statement-breakpoint)/
    )?.[0];
    if (!backfill) throw new Error("0057 default-key backfill missing");
    await db.execute(sql.raw(backfill));

    const [defaultKey] = await db
      .select({ active: virtualKeys.active, isDefault: virtualKeys.isDefault })
      .from(virtualKeys)
      .where(eq(virtualKeys.billingAccountId, existingAccountId));
    expect(defaultKey).toEqual({ active: true, isDefault: true });
  });

  it("creates a default virtual key for a compatibility user binding", async () => {
    const legacyUserId = randomUUID();
    await db.insert(users).values({
      id: legacyUserId,
      name: "Post-0055 compatibility user",
      walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
    });
    await db.insert(userBindings).values({
      id: randomUUID(),
      userId: legacyUserId,
      provider: "github",
      externalId: `legacy-${randomUUID()}`,
      providerLogin: "legacy-binding",
    });
    const [account] = await db
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, legacyUserId));
    expect(account).toBeDefined();
    if (!account) throw new Error("compatibility account missing");
    const [defaultKey] = await db
      .select({ active: virtualKeys.active })
      .from(virtualKeys)
      .where(eq(virtualKeys.billingAccountId, account.id));
    expect(defaultKey).toEqual({ active: true });
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
    const prepared = await identity.upgradeLegacy(input);
    expect(prepared.grantTransferRequired).toBe(true);
    if (!prepared.grantTransferRequired) throw new Error("expected transfer");
    await expect(identity.authenticate(prepared.apiKey)).resolves.toBeNull();
    await identity.completeLegacyUpgrade({
      legacyUserId: userId,
      credentialId: prepared.credentialId,
      transferLeaseId: prepared.transferLeaseId,
    });
    const retry = await identity.upgradeLegacy(input);

    expect(retry).toMatchObject({
      actorId: prepared.actorId,
      principalId: prepared.principalId,
      credentialId: prepared.credentialId,
      apiKey: prepared.apiKey,
      billingAccountId: prepared.billingAccountId,
      grantTransferRequired: false,
    });
    expect(retry.billingAccountId).toBe(billingAccountId);
    expect(retry.principalId).toBe(`agent:${nodeId}/${retry.actorId}`);
    await expect(identity.authenticate(retry.apiKey)).resolves.toMatchObject({
      principal: {
        actorId: retry.actorId,
        legacyUserId: userId,
        billingAccountId,
      },
    });
  });

  it("rejects a new upgrade key and never revives a rotated predecessor", async () => {
    const { legacyUserId } = await createLegacyFixture("rotated legacy agent");
    const input = {
      legacyToken: "cogni_ag_sk_v1_rotated-legacy-token",
      legacyUserId,
      displayName: "rotated-legacy-agent",
      idempotencyKey: randomUUID(),
    };
    const prepared = await identity.upgradeLegacy(input);
    if (!prepared.grantTransferRequired) throw new Error("expected transfer");

    await expect(
      identity.upgradeLegacy({ ...input, idempotencyKey: randomUUID() })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "invalid_credential",
    });

    await identity.completeLegacyUpgrade({
      legacyUserId,
      credentialId: prepared.credentialId,
      transferLeaseId: prepared.transferLeaseId,
    });
    const rotated = await identity.rotate({
      token: prepared.apiKey,
      idempotencyKey: randomUUID(),
    });
    await identity.confirm(rotated.apiKey);

    await expect(identity.upgradeLegacy(input)).rejects.toMatchObject<
      Partial<AgentIdentityError>
    >({ code: "invalid_credential" });
    await expect(
      identity.upgradeLegacy({ ...input, idempotencyKey: randomUUID() })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "invalid_credential",
    });
    await expect(identity.authenticate(prepared.apiKey)).resolves.toBeNull();
    await expect(identity.authenticate(rotated.apiKey)).resolves.toMatchObject({
      principal: { actorId: prepared.actorId },
    });
  });

  it("serializes concurrent legacy upgrade attempts and resumes an abandoned copy", async () => {
    const { legacyUserId } = await createLegacyFixture(
      "concurrent legacy agent"
    );
    const input = {
      legacyToken: "cogni_ag_sk_v1_concurrent-legacy-token",
      legacyUserId,
      displayName: "concurrent-legacy-agent",
      idempotencyKey: randomUUID(),
    };
    const attempts = await Promise.allSettled([
      identity.upgradeLegacy(input),
      identity.upgradeLegacy(input),
    ]);
    const fulfilled = attempts.find(
      (
        attempt
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof identity.upgradeLegacy>>
      > => attempt.status === "fulfilled"
    );
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected"
    );
    expect(fulfilled?.value.grantTransferRequired).toBe(true);
    expect(rejected?.reason).toMatchObject({ code: "rotation_pending" });
    if (!fulfilled?.value.grantTransferRequired) {
      throw new Error("expected one transfer owner");
    }

    await identity.releaseLegacyUpgrade({
      legacyUserId,
      credentialId: fulfilled.value.credentialId,
      transferLeaseId: fulfilled.value.transferLeaseId,
    });
    const resumed = await identity.upgradeLegacy(input);
    expect(resumed.credentialId).toBe(fulfilled.value.credentialId);
    expect(resumed.grantTransferRequired).toBe(true);
    if (!resumed.grantTransferRequired) throw new Error("expected resume");
    expect(resumed.transferLeaseId).not.toBe(fulfilled.value.transferLeaseId);
    await identity.completeLegacyUpgrade({
      legacyUserId,
      credentialId: resumed.credentialId,
      transferLeaseId: resumed.transferLeaseId,
    });
  });

  it("applies the active-agent billing cap to a first legacy upgrade", async () => {
    const cappedUserId = randomUUID();
    const cappedBillingAccountId = randomUUID();
    const cappedActorIds = Array.from({ length: 25 }, () => randomUUID());
    await db.insert(users).values({
      id: cappedUserId,
      name: "Capped legacy steward",
      walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
    });
    await db.insert(billingAccounts).values({
      id: cappedBillingAccountId,
      ownerUserId: cappedUserId,
      balanceCredits: 0n,
      authorizationOwnerBootstrappedAt: now,
    });
    await db.insert(actors).values(
      cappedActorIds.map((id, index) => ({
        id,
        kind: "agent" as const,
        displayName: `legacy-cap-fixture-${index}`,
        billingAccountId: cappedBillingAccountId,
      }))
    );

    await expect(
      identity.upgradeLegacy({
        legacyToken: "cogni_ag_sk_v1_capped-legacy-token",
        legacyUserId: cappedUserId,
        displayName: "capped-legacy-agent",
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject<Partial<AgentIdentityError>>({
      code: "spawn_limit",
    });

    await db.delete(actors).where(inArray(actors.id, cappedActorIds));
    await db
      .delete(billingAccounts)
      .where(eq(billingAccounts.id, cappedBillingAccountId));
    await db.delete(users).where(eq(users.id, cappedUserId));
  });
});
