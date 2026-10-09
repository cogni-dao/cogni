// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/identity/agent-identity`
 * Purpose: Postgres-backed durable agent actors, grants, and node-local opaque credentials.
 * Scope: Owns transactional spawn/recovery/rotation state. Does not grant OpenFGA permissions or mutate attribution.
 * Invariants: HASH_ONLY_STORAGE; NODE_LOCAL_BEARER; ROTATION_PRESERVES_ACTOR; OLD_VALID_UNTIL_CONFIRM.
 * Side-effects: PostgreSQL reads/writes and cryptographic RNG.
 * Links: task.5211, task.5217
 * @public
 */

import {
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  actorStewardshipEvents,
  actors,
  agentCredentials,
  agentRecoveryGrants,
  agentSpawnGrants,
} from "@cogni/db-schema/identity";
import { billingAccounts } from "@cogni/db-schema/refs";
import type { AgentRequestPrincipal } from "@cogni/node-contracts";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "@/adapters/server/db/client";
import {
  type AgentCredentialMaterial,
  type AgentCredentialStatus,
  AgentIdentityError,
  type AgentIdentityPort,
} from "@/ports";

const CREDENTIAL_PREFIX = "cogni_ag_sk_v2_";
const SPAWN_TOKEN_PREFIX = "cogni_ag_sg_v1_";
const RECOVERY_TOKEN_PREFIX = "cogni_ag_rg_v1_";
const SPAWN_TTL_MS = 10 * 60 * 1000;
const AUTHENTICATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_AGENTS_PER_BILLING_ACCOUNT = 25;
const MAX_OUTSTANDING_GRANTS_PER_ISSUER = 5;

type ParsedCredential = { readonly id: string; readonly secret: string };

function hashOpaque(label: string, value: string): string {
  // These are 256-bit machine-generated bearer secrets, not human passwords.
  // A fast, domain-separated PRF avoids making unauthenticated redemption a
  // CPU-exhaustion primitive while keeping only verification material.
  return createHmac("sha256", value)
    .update(`cogni-agent-v2\0${label}`, "utf8")
    .digest("hex");
}

function deriveSecret(label: string, material: string): string {
  return Buffer.from(
    hkdfSync("sha256", material, "cogni-agent-v2", label, 32)
  ).toString("base64url");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function credentialToken(id: string, secret: string): string {
  return `${CREDENTIAL_PREFIX}${id}.${secret}`;
}

function parseCredential(token: string): ParsedCredential | null {
  if (!token.startsWith(CREDENTIAL_PREFIX)) return null;
  const value = token.slice(CREDENTIAL_PREFIX.length);
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;
  const id = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (id.length > 64 || secret.length > 128) return null;
  return { id, secret };
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function asIso(value: Date): string {
  return value.toISOString();
}

function principal(input: {
  nodeId: string;
  actorId: string;
  credentialId: string;
  billingAccountId: string;
  displayName: string | null;
  legacyUserId: string | null;
}): AgentRequestPrincipal {
  return {
    kind: "agent",
    principalId: `agent:${input.nodeId}/${input.actorId}`,
    actorId: input.actorId,
    credentialId: input.credentialId,
    billingAccountId: input.billingAccountId,
    displayName: input.displayName,
    legacyUserId: input.legacyUserId,
  };
}

export class DrizzleAgentIdentityAdapter implements AgentIdentityPort {
  constructor(
    private readonly db: Database,
    private readonly nodeId: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async ensureHumanActor(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    userId: string
  ): Promise<{ id: string; billingAccountId: string }> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`human-actor:${userId}`}))`
    );
    const [existing] = await tx
      .select({ id: actors.id, billingAccountId: actors.billingAccountId })
      .from(actors)
      .where(and(eq(actors.kind, "user"), eq(actors.userId, userId)))
      .limit(1);
    if (existing) return existing;

    const [billing] = await tx
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, userId))
      .limit(1);
    if (!billing) {
      throw new AgentIdentityError(
        "billing_account_missing",
        "A billing account is required before spawning an agent"
      );
    }

    const id = randomUUID();
    await tx.insert(actors).values({
      id,
      kind: "user",
      userId,
      billingAccountId: billing.id,
    });
    return { id, billingAccountId: billing.id };
  }

  async createSpawnGrant(input: {
    issuerUserId: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ grantId: string; token: string; expiresAt: string }> {
    const token = randomToken(SPAWN_TOKEN_PREFIX);
    const tokenHash = hashOpaque("spawn-grant", token);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SPAWN_TTL_MS);

    return this.db.transaction(async (tx) => {
      const issuer = await this.ensureHumanActor(tx, input.issuerUserId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent-spawn:${issuer.billingAccountId}`}))`
      );

      const [active] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(actors)
        .where(
          and(
            eq(actors.kind, "agent"),
            eq(actors.billingAccountId, issuer.billingAccountId),
            eq(actors.status, "active")
          )
        );
      if ((active?.count ?? 0) >= MAX_ACTIVE_AGENTS_PER_BILLING_ACCOUNT) {
        throw new AgentIdentityError(
          "spawn_limit",
          "Active agent limit reached"
        );
      }

      const [outstanding] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agentSpawnGrants)
        .where(
          and(
            eq(agentSpawnGrants.issuerActorId, issuer.id),
            eq(agentSpawnGrants.status, "pending"),
            gt(agentSpawnGrants.expiresAt, now)
          )
        );
      if ((outstanding?.count ?? 0) >= MAX_OUTSTANDING_GRANTS_PER_ISSUER) {
        throw new AgentIdentityError(
          "spawn_limit",
          "Outstanding spawn grant limit reached"
        );
      }

      const [sameRequest] = await tx
        .select({ id: agentSpawnGrants.id })
        .from(agentSpawnGrants)
        .where(
          and(
            eq(agentSpawnGrants.issuerActorId, issuer.id),
            eq(agentSpawnGrants.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (sameRequest) {
        throw new AgentIdentityError(
          "invalid_grant",
          "Spawn grant was already issued for this idempotency key"
        );
      }

      const grantId = randomUUID();
      await tx.insert(agentSpawnGrants).values({
        id: grantId,
        tokenHash,
        nodeId: this.nodeId,
        issuerActorId: issuer.id,
        acceptedParentActorId: issuer.id,
        billingAccountId: issuer.billingAccountId,
        agentName: input.name,
        idempotencyKey: input.idempotencyKey,
        expiresAt,
      });
      return { grantId, token, expiresAt: asIso(expiresAt) };
    });
  }

  async redeemSpawnGrant(token: string): Promise<AgentCredentialMaterial> {
    const tokenHash = hashOpaque("spawn-grant", token);
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`spawn-redeem:${tokenHash}`}))`
      );
      const [grant] = await tx
        .select()
        .from(agentSpawnGrants)
        .where(eq(agentSpawnGrants.tokenHash, tokenHash))
        .limit(1);
      if (
        !grant ||
        grant.nodeId !== this.nodeId ||
        grant.status === "revoked"
      ) {
        throw new AgentIdentityError("invalid_grant", "Invalid spawn grant");
      }
      if (grant.expiresAt <= now) {
        throw new AgentIdentityError("grant_expired", "Spawn grant expired");
      }

      const secret = deriveSecret("spawn-credential", token);
      if (grant.status === "redeemed" && grant.redeemedActorId) {
        const [existing] = await tx
          .select({
            credentialId: agentCredentials.id,
            actorId: actors.id,
            billingAccountId: actors.billingAccountId,
            authenticateUntil: agentCredentials.authenticateUntil,
            renewUntil: agentCredentials.renewUntil,
          })
          .from(agentCredentials)
          .innerJoin(actors, eq(agentCredentials.actorId, actors.id))
          .where(
            and(
              eq(agentCredentials.actorId, grant.redeemedActorId),
              isNull(agentCredentials.predecessorCredentialId)
            )
          )
          .limit(1);
        if (!existing) {
          throw new AgentIdentityError(
            "invalid_grant",
            "Redeemed grant is incomplete"
          );
        }
        return this.material(existing, secret);
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent-spawn:${grant.billingAccountId}`}))`
      );
      const [active] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(actors)
        .where(
          and(
            eq(actors.kind, "agent"),
            eq(actors.billingAccountId, grant.billingAccountId),
            eq(actors.status, "active")
          )
        );
      if ((active?.count ?? 0) >= MAX_ACTIVE_AGENTS_PER_BILLING_ACCOUNT) {
        throw new AgentIdentityError(
          "spawn_limit",
          "Active agent limit reached"
        );
      }

      const actorId = randomUUID();
      const credentialId = randomUUID();
      const authenticateUntil = new Date(now.getTime() + AUTHENTICATE_TTL_MS);
      const renewUntil = new Date(authenticateUntil.getTime() + RENEW_GRACE_MS);
      await tx.insert(actors).values({
        id: actorId,
        kind: "agent",
        displayName: grant.agentName,
        billingAccountId: grant.billingAccountId,
        spawnedByActorId: grant.issuerActorId,
        parentActorId: grant.acceptedParentActorId,
      });
      if (grant.acceptedParentActorId) {
        await tx.insert(actorStewardshipEvents).values({
          id: randomUUID(),
          actorId,
          parentActorId: grant.acceptedParentActorId,
          eventType: "accepted",
          authorizedByActorId: grant.acceptedParentActorId,
          evidence: { spawnGrantId: grant.id },
          effectiveAt: now,
        });
      }
      await tx.insert(agentCredentials).values({
        id: credentialId,
        actorId,
        nodeId: this.nodeId,
        secretHash: hashOpaque("credential", secret),
        status: "active",
        authenticateUntil,
        renewUntil,
        confirmedAt: now,
      });
      await tx
        .update(agentSpawnGrants)
        .set({ status: "redeemed", redeemedActorId: actorId, redeemedAt: now })
        .where(eq(agentSpawnGrants.id, grant.id));
      return this.material(
        {
          credentialId,
          actorId,
          billingAccountId: grant.billingAccountId,
          authenticateUntil,
          renewUntil,
        },
        secret
      );
    });
  }

  async authenticate(
    token: string,
    mode: "data" | "renew" = "data"
  ): Promise<AgentCredentialStatus | null> {
    const parsed = parseCredential(token);
    if (!parsed) return null;
    const [row] = await this.db
      .select({
        credentialId: agentCredentials.id,
        secretHash: agentCredentials.secretHash,
        credentialStatus: agentCredentials.status,
        nodeId: agentCredentials.nodeId,
        authenticateUntil: agentCredentials.authenticateUntil,
        renewUntil: agentCredentials.renewUntil,
        actorId: actors.id,
        actorStatus: actors.status,
        billingAccountId: actors.billingAccountId,
        displayName: actors.displayName,
        legacyUserId: actors.legacyUserId,
      })
      .from(agentCredentials)
      .innerJoin(actors, eq(agentCredentials.actorId, actors.id))
      .where(eq(agentCredentials.id, parsed.id))
      .limit(1);
    if (
      !row ||
      row.nodeId !== this.nodeId ||
      row.credentialStatus !== "active" ||
      row.actorStatus !== "active" ||
      !hashesEqual(row.secretHash, hashOpaque("credential", parsed.secret))
    ) {
      return null;
    }
    const now = this.now();
    const access = now <= row.authenticateUntil ? "active" : "renew_only";
    if (now > row.renewUntil || (mode === "data" && access !== "active")) {
      return null;
    }
    return {
      principal: principal({ ...row, nodeId: this.nodeId }),
      access,
      authenticateUntil: asIso(row.authenticateUntil),
      renewUntil: asIso(row.renewUntil),
    };
  }

  async rotate(input: { token: string; idempotencyKey: string }): Promise<
    AgentCredentialMaterial & {
      predecessorCredentialId: string;
      pendingExpiresAt: string;
    }
  > {
    const current = await this.authenticate(input.token, "renew");
    const parsed = parseCredential(input.token);
    if (!current || !parsed) {
      throw new AgentIdentityError("invalid_credential", "Invalid credential");
    }
    const secret = deriveSecret(
      "rotate-credential",
      `${parsed.secret}\0${input.idempotencyKey}`
    );
    const now = this.now();

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`credential-rotate:${parsed.id}`}))`
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent-credentials:${current.principal.actorId}`}))`
      );
      const [lockedCurrent] = await tx
        .select({
          secretHash: agentCredentials.secretHash,
          credentialStatus: agentCredentials.status,
          nodeId: agentCredentials.nodeId,
          renewUntil: agentCredentials.renewUntil,
          actorId: actors.id,
          actorStatus: actors.status,
        })
        .from(agentCredentials)
        .innerJoin(actors, eq(agentCredentials.actorId, actors.id))
        .where(eq(agentCredentials.id, parsed.id))
        .limit(1);
      if (
        !lockedCurrent ||
        lockedCurrent.actorId !== current.principal.actorId ||
        lockedCurrent.nodeId !== this.nodeId ||
        lockedCurrent.credentialStatus !== "active" ||
        lockedCurrent.actorStatus !== "active" ||
        lockedCurrent.renewUntil < now ||
        !hashesEqual(
          lockedCurrent.secretHash,
          hashOpaque("credential", parsed.secret)
        )
      ) {
        throw new AgentIdentityError(
          "invalid_credential",
          "Invalid credential"
        );
      }
      const [pending] = await tx
        .select()
        .from(agentCredentials)
        .where(
          and(
            eq(agentCredentials.predecessorCredentialId, parsed.id),
            eq(agentCredentials.status, "pending")
          )
        )
        .limit(1);
      if (pending?.pendingExpiresAt && pending.pendingExpiresAt > now) {
        if (pending.rotationIdempotencyKey !== input.idempotencyKey) {
          throw new AgentIdentityError(
            "rotation_pending",
            "A credential rotation is already pending"
          );
        }
        return {
          ...this.material(
            {
              credentialId: pending.id,
              actorId: current.principal.actorId,
              billingAccountId: current.principal.billingAccountId,
              authenticateUntil: pending.authenticateUntil,
              renewUntil: pending.renewUntil,
            },
            secret
          ),
          predecessorCredentialId: parsed.id,
          pendingExpiresAt: asIso(pending.pendingExpiresAt),
        };
      }
      if (pending) {
        await tx
          .update(agentCredentials)
          .set({ status: "revoked", revokedAt: now })
          .where(eq(agentCredentials.id, pending.id));
      }

      const credentialId = randomUUID();
      const authenticateUntil = new Date(now.getTime() + AUTHENTICATE_TTL_MS);
      const renewUntil = new Date(authenticateUntil.getTime() + RENEW_GRACE_MS);
      const pendingExpiresAt = new Date(now.getTime() + PENDING_TTL_MS);
      await tx.insert(agentCredentials).values({
        id: credentialId,
        actorId: current.principal.actorId,
        nodeId: this.nodeId,
        secretHash: hashOpaque("credential", secret),
        status: "pending",
        predecessorCredentialId: parsed.id,
        rotationIdempotencyKey: input.idempotencyKey,
        authenticateUntil,
        renewUntil,
        pendingExpiresAt,
      });
      return {
        ...this.material(
          {
            credentialId,
            actorId: current.principal.actorId,
            billingAccountId: current.principal.billingAccountId,
            authenticateUntil,
            renewUntil,
          },
          secret
        ),
        predecessorCredentialId: parsed.id,
        pendingExpiresAt: asIso(pendingExpiresAt),
      };
    });
  }

  async confirm(token: string): Promise<AgentCredentialStatus> {
    const parsed = parseCredential(token);
    if (!parsed) {
      throw new AgentIdentityError("invalid_credential", "Invalid credential");
    }
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`credential-confirm:${parsed.id}`}))`
      );
      const [credentialActor] = await tx
        .select({ actorId: agentCredentials.actorId })
        .from(agentCredentials)
        .where(eq(agentCredentials.id, parsed.id))
        .limit(1);
      if (!credentialActor) {
        throw new AgentIdentityError(
          "invalid_credential",
          "Invalid credential"
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent-credentials:${credentialActor.actorId}`}))`
      );
      const [row] = await tx
        .select({
          credentialId: agentCredentials.id,
          secretHash: agentCredentials.secretHash,
          credentialStatus: agentCredentials.status,
          nodeId: agentCredentials.nodeId,
          predecessorCredentialId: agentCredentials.predecessorCredentialId,
          pendingExpiresAt: agentCredentials.pendingExpiresAt,
          confirmedAt: agentCredentials.confirmedAt,
          authenticateUntil: agentCredentials.authenticateUntil,
          renewUntil: agentCredentials.renewUntil,
          actorId: actors.id,
          actorStatus: actors.status,
          billingAccountId: actors.billingAccountId,
          displayName: actors.displayName,
          legacyUserId: actors.legacyUserId,
        })
        .from(agentCredentials)
        .innerJoin(actors, eq(agentCredentials.actorId, actors.id))
        .where(eq(agentCredentials.id, parsed.id))
        .limit(1);
      if (
        !row ||
        row.nodeId !== this.nodeId ||
        row.actorStatus !== "active" ||
        !hashesEqual(row.secretHash, hashOpaque("credential", parsed.secret))
      ) {
        throw new AgentIdentityError(
          "invalid_credential",
          "Invalid credential"
        );
      }
      if (row.credentialStatus === "active" && row.confirmedAt) {
        if (row.renewUntil < now) {
          throw new AgentIdentityError(
            "invalid_credential",
            "Credential renewal window expired"
          );
        }
        return this.status(
          row,
          row.authenticateUntil < now ? "renew_only" : "active"
        );
      }
      if (
        row.credentialStatus !== "pending" ||
        !row.predecessorCredentialId ||
        !row.pendingExpiresAt ||
        row.pendingExpiresAt <= now
      ) {
        throw new AgentIdentityError(
          "invalid_credential",
          "Pending credential expired"
        );
      }
      await tx
        .update(agentCredentials)
        .set({ status: "active", confirmedAt: now, pendingExpiresAt: null })
        .where(eq(agentCredentials.id, row.credentialId));
      await tx
        .update(agentCredentials)
        .set({
          status: "revoked",
          revokedAt: now,
          replacedByCredentialId: row.credentialId,
        })
        .where(eq(agentCredentials.id, row.predecessorCredentialId));
      return this.status(row, "active");
    });
  }

  async createRecoveryGrant(input: {
    issuerUserId: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<{ grantId: string; token: string; expiresAt: string }> {
    const token = randomToken(RECOVERY_TOKEN_PREFIX);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SPAWN_TTL_MS);
    return this.db.transaction(async (tx) => {
      const issuer = await this.ensureHumanActor(tx, input.issuerUserId);
      const [target] = await tx
        .select({ parentActorId: actors.parentActorId })
        .from(actors)
        .where(
          and(
            eq(actors.id, input.actorId),
            eq(actors.kind, "agent"),
            eq(actors.status, "active")
          )
        )
        .limit(1);
      if (!target || target.parentActorId !== issuer.id) {
        throw new AgentIdentityError(
          "recovery_denied",
          "Only the accepted steward may recover this agent"
        );
      }
      const grantId = randomUUID();
      await tx.insert(agentRecoveryGrants).values({
        id: grantId,
        tokenHash: hashOpaque("recovery-grant", token),
        nodeId: this.nodeId,
        actorId: input.actorId,
        issuerActorId: issuer.id,
        idempotencyKey: input.idempotencyKey,
        expiresAt,
      });
      return { grantId, token, expiresAt: asIso(expiresAt) };
    });
  }

  async recover(token: string): Promise<AgentCredentialMaterial> {
    const tokenHash = hashOpaque("recovery-grant", token);
    const secret = deriveSecret("recover-credential", token);
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent-recover:${tokenHash}`}))`
      );
      const [grantActor] = await tx
        .select({ actorId: agentRecoveryGrants.actorId })
        .from(agentRecoveryGrants)
        .where(eq(agentRecoveryGrants.tokenHash, tokenHash))
        .limit(1);
      if (!grantActor) {
        throw new AgentIdentityError("invalid_grant", "Invalid recovery grant");
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent-credentials:${grantActor.actorId}`}))`
      );
      const [grant] = await tx
        .select({
          id: agentRecoveryGrants.id,
          nodeId: agentRecoveryGrants.nodeId,
          actorId: agentRecoveryGrants.actorId,
          status: agentRecoveryGrants.status,
          expiresAt: agentRecoveryGrants.expiresAt,
          redeemedCredentialId: agentRecoveryGrants.redeemedCredentialId,
          billingAccountId: actors.billingAccountId,
          actorStatus: actors.status,
        })
        .from(agentRecoveryGrants)
        .innerJoin(actors, eq(agentRecoveryGrants.actorId, actors.id))
        .where(eq(agentRecoveryGrants.tokenHash, tokenHash))
        .limit(1);
      if (
        !grant ||
        grant.nodeId !== this.nodeId ||
        grant.status === "revoked" ||
        grant.actorStatus !== "active"
      ) {
        throw new AgentIdentityError("invalid_grant", "Invalid recovery grant");
      }
      if (grant.expiresAt <= now) {
        throw new AgentIdentityError("grant_expired", "Recovery grant expired");
      }
      if (grant.status === "redeemed" && grant.redeemedCredentialId) {
        const [existing] = await tx
          .select()
          .from(agentCredentials)
          .where(eq(agentCredentials.id, grant.redeemedCredentialId))
          .limit(1);
        if (!existing) {
          throw new AgentIdentityError(
            "invalid_grant",
            "Recovery is incomplete"
          );
        }
        return this.material(
          {
            credentialId: existing.id,
            actorId: grant.actorId,
            billingAccountId: grant.billingAccountId,
            authenticateUntil: existing.authenticateUntil,
            renewUntil: existing.renewUntil,
          },
          secret
        );
      }
      const credentialId = randomUUID();
      const authenticateUntil = new Date(now.getTime() + AUTHENTICATE_TTL_MS);
      const renewUntil = new Date(authenticateUntil.getTime() + RENEW_GRACE_MS);
      await tx.insert(agentCredentials).values({
        id: credentialId,
        actorId: grant.actorId,
        nodeId: this.nodeId,
        secretHash: hashOpaque("credential", secret),
        status: "active",
        authenticateUntil,
        renewUntil,
        confirmedAt: now,
      });
      // Recovery is the lost/compromised-secret ceremony, not ordinary
      // multi-installation enrollment. Cut off every predecessor immediately
      // in the same transaction that activates the recovered credential.
      await tx
        .update(agentCredentials)
        .set({
          status: "revoked",
          revokedAt: now,
          replacedByCredentialId: credentialId,
        })
        .where(
          and(
            eq(agentCredentials.actorId, grant.actorId),
            ne(agentCredentials.id, credentialId),
            inArray(agentCredentials.status, ["active", "pending"])
          )
        );
      await tx
        .update(agentRecoveryGrants)
        .set({
          status: "redeemed",
          redeemedCredentialId: credentialId,
          redeemedAt: now,
        })
        .where(eq(agentRecoveryGrants.id, grant.id));
      return this.material(
        {
          credentialId,
          actorId: grant.actorId,
          billingAccountId: grant.billingAccountId,
          authenticateUntil,
          renewUntil,
        },
        secret
      );
    });
  }

  async upgradeLegacy(input: {
    legacyToken: string;
    legacyUserId: string;
    displayName: string | null;
    idempotencyKey: string;
  }): Promise<AgentCredentialMaterial> {
    const secret = deriveSecret(
      "legacy-upgrade",
      `${input.legacyToken}\0${input.idempotencyKey}`
    );
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`legacy-agent:${input.legacyUserId}`}))`
      );
      const [billing] = await tx
        .select({ id: billingAccounts.id })
        .from(billingAccounts)
        .where(eq(billingAccounts.ownerUserId, input.legacyUserId))
        .limit(1);
      if (!billing) {
        throw new AgentIdentityError(
          "billing_account_missing",
          "Legacy billing account not found"
        );
      }
      let [actor] = await tx
        .select({ id: actors.id, billingAccountId: actors.billingAccountId })
        .from(actors)
        .where(eq(actors.legacyUserId, input.legacyUserId))
        .limit(1);
      if (!actor) {
        const actorId = randomUUID();
        await tx.insert(actors).values({
          id: actorId,
          kind: "agent",
          displayName: input.displayName,
          legacyUserId: input.legacyUserId,
          billingAccountId: billing.id,
        });
        actor = { id: actorId, billingAccountId: billing.id };
      }
      const secretHash = hashOpaque("credential", secret);
      const [existing] = await tx
        .select()
        .from(agentCredentials)
        .where(
          and(
            eq(agentCredentials.actorId, actor.id),
            eq(agentCredentials.secretHash, secretHash),
            ne(agentCredentials.status, "revoked")
          )
        )
        .limit(1);
      if (existing) {
        return this.material(
          {
            credentialId: existing.id,
            actorId: actor.id,
            billingAccountId: actor.billingAccountId,
            authenticateUntil: existing.authenticateUntil,
            renewUntil: existing.renewUntil,
          },
          secret
        );
      }
      const credentialId = randomUUID();
      const authenticateUntil = new Date(now.getTime() + AUTHENTICATE_TTL_MS);
      const renewUntil = new Date(authenticateUntil.getTime() + RENEW_GRACE_MS);
      await tx.insert(agentCredentials).values({
        id: credentialId,
        actorId: actor.id,
        nodeId: this.nodeId,
        secretHash,
        status: "active",
        authenticateUntil,
        renewUntil,
        confirmedAt: now,
      });
      return this.material(
        {
          credentialId,
          actorId: actor.id,
          billingAccountId: actor.billingAccountId,
          authenticateUntil,
          renewUntil,
        },
        secret
      );
    });
  }

  private material(
    row: {
      credentialId: string;
      actorId: string;
      billingAccountId: string;
      authenticateUntil: Date;
      renewUntil: Date;
    },
    secret: string
  ): AgentCredentialMaterial {
    return {
      actorId: row.actorId,
      principalId: `agent:${this.nodeId}/${row.actorId}`,
      credentialId: row.credentialId,
      apiKey: credentialToken(row.credentialId, secret),
      billingAccountId: row.billingAccountId,
      authenticateUntil: asIso(row.authenticateUntil),
      renewUntil: asIso(row.renewUntil),
    };
  }

  private status(
    row: {
      actorId: string;
      credentialId: string;
      billingAccountId: string;
      displayName: string | null;
      legacyUserId: string | null;
      authenticateUntil: Date;
      renewUntil: Date;
    },
    access: "active" | "renew_only"
  ): AgentCredentialStatus {
    return {
      principal: principal({ ...row, nodeId: this.nodeId }),
      access,
      authenticateUntil: asIso(row.authenticateUntil),
      renewUntil: asIso(row.renewUntil),
    };
  }
}
