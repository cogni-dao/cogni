// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/identity/agent-identity`
 * Purpose: Postgres-backed durable agent actors, grants, and node-local opaque credentials.
 * Scope: Owns transactional spawn/recovery/rotation state. Does not grant OpenFGA permissions or mutate attribution.
 * Invariants: HASH_ONLY_STORAGE; NODE_LOCAL_BEARER; ROTATION_PRESERVES_ACTOR;
 *   OLD_VALID_UNTIL_CONFIRM; IDEMPOTENT_GRANT_ISSUANCE.
 * Side-effects: PostgreSQL reads/writes and cryptographic RNG.
 * Links: https://cognidao.org/knowledge/human-ai-identity-standard, task.5252
 * @public
 */

import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import {
  actorBindingEvents,
  actorBindings,
  actorStewardshipEvents,
  actors,
  agentCredentials,
  agentRecoveryGrants,
  agentSpawnGrants,
  existingAgentClaims,
  userBindings,
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
  type LegacyAgentUpgrade,
} from "@/ports";

const CREDENTIAL_PREFIX = "cogni_ag_sk_v2_";
const SPAWN_TOKEN_PREFIX = "cogni_ag_sg_v1_";
const RECOVERY_TOKEN_PREFIX = "cogni_ag_rg_v1_";
const SPAWN_TTL_MS = 10 * 60 * 1000;
const AUTHENTICATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const LEGACY_TRANSFER_LEASE_MS = 5 * 60 * 1000;
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

function deterministicGrantToken(
  prefix: string,
  label: string,
  issuanceKey: Buffer,
  material: string
): string {
  const secret = createHmac("sha256", issuanceKey)
    .update(`cogni-agent-v2\0${label}\0${material}`, "utf8")
    .digest("base64url");
  return `${prefix}${secret}`;
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

function legacyUpgradeFingerprint(idempotencyKey: string): string {
  return hashOpaque("legacy-upgrade-idempotency", idempotencyKey);
}

function legacyUpgradeMarker(fingerprint: string, leaseId: string): string {
  return `legacy:${fingerprint}:${leaseId}`;
}

function parseLegacyUpgradeMarker(
  value: string | null
): { fingerprint: string; leaseId: string } | null {
  if (!value?.startsWith("legacy:")) return null;
  const [, fingerprint, leaseId, ...extra] = value.split(":");
  if (!fingerprint || !leaseId || extra.length > 0) return null;
  return { fingerprint, leaseId };
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
  private readonly issuanceKey: Buffer;

  constructor(
    private readonly db: Database,
    private readonly nodeId: string,
    issuanceRootKey: string,
    private readonly now: () => Date = () => new Date()
  ) {
    // Derive a node-audienced subkey before grant-specific domain separation.
    // Even nodes accidentally provisioned with the same AUTH_SECRET cannot
    // issue or reconstruct each other's spawn/recovery tokens.
    this.issuanceKey = Buffer.from(
      hkdfSync(
        "sha256",
        issuanceRootKey,
        "cogni-agent-v2",
        `grant-issuance:${nodeId}`,
        32
      )
    );
  }

  async getAcceptedStewardship(actorId: string): Promise<{
    stewardUserId: string;
    billingAccountId: string;
  } | null> {
    const [agent] = await this.db
      .select({
        parentActorId: actors.parentActorId,
        billingAccountId: actors.billingAccountId,
      })
      .from(actors)
      .where(
        and(
          eq(actors.id, actorId),
          eq(actors.kind, "agent"),
          eq(actors.status, "active")
        )
      )
      .limit(1);
    if (!agent?.parentActorId) return null;

    const [steward] = await this.db
      .select({
        userId: actors.userId,
        billingAccountId: actors.billingAccountId,
      })
      .from(actors)
      .where(
        and(
          eq(actors.id, agent.parentActorId),
          eq(actors.kind, "user"),
          eq(actors.status, "active")
        )
      )
      .limit(1);
    if (
      !steward?.userId ||
      steward.billingAccountId !== agent.billingAccountId
    ) {
      return null;
    }
    return {
      stewardUserId: steward.userId,
      billingAccountId: agent.billingAccountId,
    };
  }

  async createExistingAgentClaim(input: {
    readonly stewardUserId: string;
    readonly actorId: string;
    readonly provider: "github";
    readonly externalId: string;
    readonly providerLogin: string | null;
    readonly attestationJti: string;
    readonly attestationEvidence: Record<string, unknown>;
    readonly attestationExpiresAt: Date;
    readonly idempotencyKey: string;
  }) {
    const now = this.now();
    if (input.attestationExpiresAt <= now) {
      throw new AgentIdentityError(
        "claim_expired",
        "Identity attestation expired"
      );
    }
    return this.db.transaction(async (tx) => {
      const steward = await this.ensureHumanActor(tx, input.stewardUserId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`existing-agent-claim:${input.actorId}`}))`
      );
      const [agent] = await tx
        .select({
          id: actors.id,
          parentActorId: actors.parentActorId,
        })
        .from(actors)
        .where(
          and(
            eq(actors.id, input.actorId),
            eq(actors.kind, "agent"),
            eq(actors.status, "active")
          )
        )
        .limit(1);
      if (
        !agent ||
        (agent.parentActorId && agent.parentActorId !== steward.id)
      ) {
        throw new AgentIdentityError(
          "claim_denied",
          "Agent is unavailable or already has another accepted steward"
        );
      }
      const [existing] = await tx
        .select()
        .from(existingAgentClaims)
        .where(
          and(
            eq(existingAgentClaims.stewardActorId, steward.id),
            eq(existingAgentClaims.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        if (
          existing.actorId !== input.actorId ||
          existing.externalId !== input.externalId ||
          existing.attestationJti !== input.attestationJti
        ) {
          throw new AgentIdentityError(
            "claim_conflict",
            "Existing-agent claim idempotency conflict"
          );
        }
        return {
          claimId: existing.id,
          actorId: existing.actorId,
          provider: "github" as const,
          providerLogin: existing.providerLogin,
          status: existing.status as "pending_ai_acceptance" | "accepted",
          expiresAt: asIso(existing.expiresAt),
        };
      }
      const [sourceOwner] = await tx
        .select({ actorId: actorBindings.actorId })
        .from(actorBindings)
        .where(
          and(
            eq(actorBindings.provider, input.provider),
            eq(actorBindings.externalId, input.externalId),
            isNull(actorBindings.closedAt)
          )
        )
        .limit(1);
      if (
        sourceOwner &&
        sourceOwner.actorId !== input.actorId &&
        sourceOwner.actorId !== steward.id
      ) {
        throw new AgentIdentityError(
          "claim_denied",
          "Attested external identity already belongs to another actor"
        );
      }
      const claimId = randomUUID();
      const [created] = await tx
        .insert(existingAgentClaims)
        .values({
          id: claimId,
          actorId: input.actorId,
          stewardActorId: steward.id,
          provider: input.provider,
          externalId: input.externalId,
          providerLogin: input.providerLogin,
          attestationJti: input.attestationJti,
          attestationEvidence: input.attestationEvidence,
          idempotencyKey: input.idempotencyKey,
          expiresAt: input.attestationExpiresAt,
        })
        .returning();
      if (!created) {
        throw new AgentIdentityError("claim_conflict", "Claim insert failed");
      }
      return {
        claimId,
        actorId: input.actorId,
        provider: "github" as const,
        providerLogin: input.providerLogin,
        status: "pending_ai_acceptance" as const,
        expiresAt: asIso(input.attestationExpiresAt),
      };
    });
  }

  async acceptExistingAgentClaim(input: {
    readonly actorId: string;
    readonly claimId: string;
  }) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`existing-agent-claim:${input.actorId}`}))`
      );
      const [claim] = await tx
        .select()
        .from(existingAgentClaims)
        .where(eq(existingAgentClaims.id, input.claimId))
        .limit(1)
        .for("update");
      if (!claim || claim.actorId !== input.actorId) {
        throw new AgentIdentityError(
          "claim_denied",
          "Claim does not belong to caller"
        );
      }
      if (claim.status === "accepted") {
        return {
          claimId: claim.id,
          actorId: claim.actorId,
          provider: "github" as const,
          providerLogin: claim.providerLogin,
          status: "accepted" as const,
          expiresAt: asIso(claim.expiresAt),
        };
      }
      if (
        claim.status !== "pending_ai_acceptance" ||
        claim.expiresAt <= this.now()
      ) {
        throw new AgentIdentityError(
          "claim_expired",
          "Claim is no longer active"
        );
      }
      const [agent] = await tx
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
      if (
        !agent ||
        (agent.parentActorId && agent.parentActorId !== claim.stewardActorId)
      ) {
        throw new AgentIdentityError(
          "claim_denied",
          "Agent stewardship changed"
        );
      }
      const [sourceOwner] = await tx
        .select({ id: actorBindings.id, actorId: actorBindings.actorId })
        .from(actorBindings)
        .where(
          and(
            eq(actorBindings.provider, claim.provider),
            eq(actorBindings.externalId, claim.externalId),
            isNull(actorBindings.closedAt)
          )
        )
        .limit(1)
        .for("update");
      if (
        sourceOwner &&
        sourceOwner.actorId !== input.actorId &&
        sourceOwner.actorId !== claim.stewardActorId
      ) {
        throw new AgentIdentityError(
          "claim_denied",
          "External identity ownership changed before acceptance"
        );
      }
      const acceptedAt = this.now();
      if (sourceOwner?.actorId === claim.stewardActorId) {
        const transferEvidence = {
          claimId: claim.id,
          attestationJti: claim.attestationJti,
          humanAcceptedByActorId: claim.stewardActorId,
          aiAcceptedByActorId: input.actorId,
        };
        await tx.insert(actorBindingEvents).values({
          id: randomUUID(),
          actorId: sourceOwner.actorId,
          previousActorId: sourceOwner.actorId,
          provider: claim.provider,
          externalId: claim.externalId,
          providerLogin: claim.providerLogin,
          eventType: "transferred_out",
          authorizedByActorId: claim.stewardActorId,
          evidence: transferEvidence,
          effectiveAt: acceptedAt,
        });
        await tx
          .update(actorBindings)
          .set({ closedAt: acceptedAt })
          .where(eq(actorBindings.id, sourceOwner.id));
        await tx
          .delete(userBindings)
          .where(
            and(
              eq(userBindings.provider, claim.provider),
              eq(userBindings.externalId, claim.externalId)
            )
          );
      }
      if (!sourceOwner || sourceOwner.actorId === claim.stewardActorId) {
        const bindingEventId = randomUUID();
        await tx.insert(actorBindingEvents).values({
          id: bindingEventId,
          actorId: input.actorId,
          previousActorId: sourceOwner?.actorId ?? null,
          provider: claim.provider,
          externalId: claim.externalId,
          providerLogin: claim.providerLogin,
          eventType: sourceOwner ? "transferred_in" : "bound",
          authorizedByActorId: input.actorId,
          evidence: {
            claimId: claim.id,
            attestationJti: claim.attestationJti,
            humanAcceptedByActorId: claim.stewardActorId,
            aiAcceptedByActorId: input.actorId,
          },
          effectiveAt: acceptedAt,
        });
        await tx.insert(actorBindings).values({
          id: randomUUID(),
          actorId: input.actorId,
          provider: claim.provider,
          externalId: claim.externalId,
          providerLogin: claim.providerLogin,
          evidenceEventId: bindingEventId,
          createdAt: acceptedAt,
        });
      }
      if (!agent.parentActorId) {
        await tx
          .update(actors)
          .set({ parentActorId: claim.stewardActorId, updatedAt: acceptedAt })
          .where(eq(actors.id, input.actorId));
        await tx.insert(actorStewardshipEvents).values({
          id: randomUUID(),
          actorId: input.actorId,
          parentActorId: claim.stewardActorId,
          eventType: "accepted",
          authorizedByActorId: input.actorId,
          evidence: {
            claimId: claim.id,
            humanAcceptedByActorId: claim.stewardActorId,
            aiAcceptedByActorId: input.actorId,
          },
          effectiveAt: acceptedAt,
        });
      }
      await tx
        .update(existingAgentClaims)
        .set({ status: "accepted", acceptedAt })
        .where(eq(existingAgentClaims.id, claim.id));
      return {
        claimId: claim.id,
        actorId: claim.actorId,
        provider: "github" as const,
        providerLogin: claim.providerLogin,
        status: "accepted" as const,
        expiresAt: asIso(claim.expiresAt),
      };
    });
  }

  async suspendAgent(input: {
    readonly stewardUserId: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<{ readonly actorId: string; readonly status: "suspended" }> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const steward = await this.ensureHumanActor(tx, input.stewardUserId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent-lifecycle:${input.actorId}`}))`
      );
      const [agent] = await tx
        .select({
          status: actors.status,
          parentActorId: actors.parentActorId,
        })
        .from(actors)
        .where(and(eq(actors.id, input.actorId), eq(actors.kind, "agent")))
        .limit(1)
        .for("update");
      if (!agent || agent.parentActorId !== steward.id) {
        throw new AgentIdentityError(
          "recovery_denied",
          "Only the accepted steward may suspend this agent"
        );
      }
      if (agent.status === "suspended") {
        return { actorId: input.actorId, status: "suspended" };
      }
      await tx
        .update(actors)
        .set({ status: "suspended", updatedAt: now })
        .where(eq(actors.id, input.actorId));
      await tx
        .update(agentCredentials)
        .set({ status: "revoked", revokedAt: now })
        .where(
          and(
            eq(agentCredentials.actorId, input.actorId),
            inArray(agentCredentials.status, ["active", "pending"])
          )
        );
      await tx
        .update(agentRecoveryGrants)
        .set({ status: "revoked" })
        .where(
          and(
            eq(agentRecoveryGrants.actorId, input.actorId),
            eq(agentRecoveryGrants.status, "pending")
          )
        );
      await tx.insert(actorStewardshipEvents).values({
        id: randomUUID(),
        actorId: input.actorId,
        parentActorId: steward.id,
        eventType: "revoked",
        authorizedByActorId: steward.id,
        evidence: { reason: input.reason, action: "agent_suspended" },
        effectiveAt: now,
      });
      return { actorId: input.actorId, status: "suspended" };
    });
  }

  private async ensureHumanActor(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    userId: string
  ): Promise<{ id: string; billingAccountId: string }> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`human-actor:${userId}`}))`
    );
    const [existing] = await tx
      .select({
        id: actors.id,
        billingAccountId: actors.billingAccountId,
        authorizationOwnerBootstrappedAt:
          billingAccounts.authorizationOwnerBootstrappedAt,
      })
      .from(actors)
      .innerJoin(
        billingAccounts,
        eq(billingAccounts.id, actors.billingAccountId)
      )
      .where(and(eq(actors.kind, "user"), eq(actors.userId, userId)))
      .limit(1);
    if (existing) {
      if (!existing.authorizationOwnerBootstrappedAt) {
        throw new AgentIdentityError(
          "billing_account_missing",
          "Billing account authority bootstrap is pending"
        );
      }
      return {
        id: existing.id,
        billingAccountId: existing.billingAccountId,
      };
    }

    const [billing] = await tx
      .select({
        id: billingAccounts.id,
        authorizationOwnerBootstrappedAt:
          billingAccounts.authorizationOwnerBootstrappedAt,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, userId))
      .limit(1);
    if (!billing?.authorizationOwnerBootstrappedAt) {
      throw new AgentIdentityError(
        "billing_account_missing",
        "An authority-ready billing account is required before managing an agent"
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

  private async lockIssuerGrants(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    issuerActorId: string
  ): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`agent-grants:${issuerActorId}`}))`
    );
  }

  private async assertOutstandingGrantCapacity(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    issuerActorId: string,
    now: Date
  ): Promise<void> {
    // Callers hold the issuer-wide grant lock. One shared ceiling prevents
    // alternating spawn and recovery requests from bypassing a per-table bound.
    const [[spawn], [recovery]] = await Promise.all([
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agentSpawnGrants)
        .where(
          and(
            eq(agentSpawnGrants.issuerActorId, issuerActorId),
            eq(agentSpawnGrants.status, "pending"),
            gt(agentSpawnGrants.expiresAt, now)
          )
        ),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agentRecoveryGrants)
        .where(
          and(
            eq(agentRecoveryGrants.issuerActorId, issuerActorId),
            eq(agentRecoveryGrants.status, "pending"),
            gt(agentRecoveryGrants.expiresAt, now)
          )
        ),
    ]);
    if (
      (spawn?.count ?? 0) + (recovery?.count ?? 0) >=
      MAX_OUTSTANDING_GRANTS_PER_ISSUER
    ) {
      throw new AgentIdentityError(
        "grant_limit",
        "Outstanding agent grant limit reached"
      );
    }
  }

  async createSpawnGrant(input: {
    issuerUserId: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ grantId: string; token: string; expiresAt: string }> {
    const now = this.now();

    return this.db.transaction(async (tx) => {
      const issuer = await this.ensureHumanActor(tx, input.issuerUserId);
      await this.lockIssuerGrants(tx, issuer.id);
      const token = deterministicGrantToken(
        SPAWN_TOKEN_PREFIX,
        "spawn-grant",
        this.issuanceKey,
        `${this.nodeId}\0${issuer.id}\0${input.name}\0${input.idempotencyKey}`
      );
      const [sameRequest] = await tx
        .select({
          id: agentSpawnGrants.id,
          agentName: agentSpawnGrants.agentName,
          status: agentSpawnGrants.status,
          expiresAt: agentSpawnGrants.expiresAt,
        })
        .from(agentSpawnGrants)
        .where(
          and(
            eq(agentSpawnGrants.issuerActorId, issuer.id),
            eq(agentSpawnGrants.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (sameRequest) {
        if (
          sameRequest.agentName !== input.name ||
          sameRequest.status !== "pending" ||
          sameRequest.expiresAt <= now
        ) {
          throw new AgentIdentityError(
            "invalid_grant",
            "Spawn grant idempotency key cannot be reused"
          );
        }
        return {
          grantId: sameRequest.id,
          token,
          expiresAt: asIso(sameRequest.expiresAt),
        };
      }

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

      await this.assertOutstandingGrantCapacity(tx, issuer.id, now);

      const grantId = randomUUID();
      const expiresAt = new Date(now.getTime() + SPAWN_TTL_MS);
      await tx.insert(agentSpawnGrants).values({
        id: grantId,
        tokenHash: hashOpaque("spawn-grant", token),
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
      if (grant.status === "redeemed" && grant.redeemedActorId) {
        // A short replay window makes a lost HTTP response recoverable, but
        // the expired one-use grant must never become a perpetual secret
        // recovery oracle. The durable actor remains recognizable below.
        if (grant.expiresAt <= now) {
          throw new AgentIdentityError(
            "grant_already_redeemed",
            "Spawn grant was redeemed; use credential recovery"
          );
        }
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
        const secret = deriveSecret("spawn-credential", token);
        return this.material(existing, secret);
      }
      if (grant.expiresAt <= now) {
        throw new AgentIdentityError("grant_expired", "Spawn grant expired");
      }

      const secret = deriveSecret("spawn-credential", token);
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
      if (pending && pending.rotationIdempotencyKey === input.idempotencyKey) {
        // A caller may lose the rotate response and retry only after the
        // pending confirmation window. The material is deterministic for this
        // predecessor + idempotency key, and secret_hash is globally unique,
        // so inserting a replacement would collide with the expired row.
        // Renew the same pending credential instead: stable identity/material,
        // bounded confirmation window, and no orphaned secret row.
        const authenticateUntil = new Date(now.getTime() + AUTHENTICATE_TTL_MS);
        const renewUntil = new Date(
          authenticateUntil.getTime() + RENEW_GRACE_MS
        );
        const pendingExpiresAt = new Date(now.getTime() + PENDING_TTL_MS);
        await tx
          .update(agentCredentials)
          .set({
            authenticateUntil,
            renewUntil,
            pendingExpiresAt,
            revokedAt: null,
          })
          .where(eq(agentCredentials.id, pending.id));
        return {
          ...this.material(
            {
              credentialId: pending.id,
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
    const now = this.now();
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
      await this.lockIssuerGrants(tx, issuer.id);
      const token = deterministicGrantToken(
        RECOVERY_TOKEN_PREFIX,
        "recovery-grant",
        this.issuanceKey,
        `${this.nodeId}\0${issuer.id}\0${input.actorId}\0${input.idempotencyKey}`
      );
      const [sameRequest] = await tx
        .select({
          id: agentRecoveryGrants.id,
          actorId: agentRecoveryGrants.actorId,
          status: agentRecoveryGrants.status,
          expiresAt: agentRecoveryGrants.expiresAt,
        })
        .from(agentRecoveryGrants)
        .where(
          and(
            eq(agentRecoveryGrants.issuerActorId, issuer.id),
            eq(agentRecoveryGrants.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (sameRequest) {
        if (
          sameRequest.actorId !== input.actorId ||
          sameRequest.status !== "pending" ||
          sameRequest.expiresAt <= now
        ) {
          throw new AgentIdentityError(
            "invalid_grant",
            "Recovery grant idempotency key cannot be reused"
          );
        }
        return {
          grantId: sameRequest.id,
          token,
          expiresAt: asIso(sameRequest.expiresAt),
        };
      }
      await this.assertOutstandingGrantCapacity(tx, issuer.id, now);
      const grantId = randomUUID();
      const expiresAt = new Date(now.getTime() + SPAWN_TTL_MS);
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
          issuerActorId: agentRecoveryGrants.issuerActorId,
          billingAccountId: actors.billingAccountId,
          actorStatus: actors.status,
          currentStewardActorId: actors.parentActorId,
        })
        .from(agentRecoveryGrants)
        .innerJoin(actors, eq(agentRecoveryGrants.actorId, actors.id))
        .where(eq(agentRecoveryGrants.tokenHash, tokenHash))
        .limit(1);
      if (
        !grant ||
        grant.nodeId !== this.nodeId ||
        grant.status === "revoked" ||
        grant.actorStatus !== "active" ||
        grant.currentStewardActorId !== grant.issuerActorId
      ) {
        throw new AgentIdentityError("invalid_grant", "Invalid recovery grant");
      }
      if (grant.status === "redeemed" && grant.redeemedCredentialId) {
        // Permit response-loss replay only while the one-use grant remains
        // live. After expiry, expose no credential material at all.
        if (grant.expiresAt <= now) {
          throw new AgentIdentityError(
            "grant_already_redeemed",
            "Recovery grant was redeemed; request a new recovery grant"
          );
        }
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
        const secret = deriveSecret("recover-credential", token);
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
      if (grant.expiresAt <= now) {
        throw new AgentIdentityError("grant_expired", "Recovery grant expired");
      }
      const secret = deriveSecret("recover-credential", token);
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
  }): Promise<LegacyAgentUpgrade> {
    const secret = deriveSecret(
      "legacy-upgrade",
      `${input.legacyToken}\0${input.idempotencyKey}`
    );
    const fingerprint = legacyUpgradeFingerprint(input.idempotencyKey);
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
      if (actor) {
        const credentials = await tx
          .select()
          .from(agentCredentials)
          .where(
            and(
              eq(agentCredentials.actorId, actor.id),
              eq(agentCredentials.nodeId, this.nodeId)
            )
          );
        const legacyCredential = credentials.find((credential) =>
          parseLegacyUpgradeMarker(credential.rotationIdempotencyKey)
        );
        if (!legacyCredential) {
          // This covers credentials minted by the pre-transition implementation.
          // Their request key and grant-copy completion were never recorded, so
          // fail closed instead of minting another credential or replaying roles.
          throw new AgentIdentityError(
            "invalid_credential",
            "Legacy credential was already upgraded"
          );
        }
        const marker = parseLegacyUpgradeMarker(
          legacyCredential.rotationIdempotencyKey
        );
        if (
          !marker ||
          marker.fingerprint !== fingerprint ||
          !hashesEqual(
            legacyCredential.secretHash,
            hashOpaque("credential", secret)
          ) ||
          legacyCredential.status === "revoked" ||
          legacyCredential.renewUntil < now
        ) {
          throw new AgentIdentityError(
            "invalid_credential",
            "Legacy credential was already upgraded"
          );
        }
        if (legacyCredential.status === "active") {
          return {
            ...this.material(
              {
                credentialId: legacyCredential.id,
                actorId: actor.id,
                billingAccountId: actor.billingAccountId,
                authenticateUntil: legacyCredential.authenticateUntil,
                renewUntil: legacyCredential.renewUntil,
              },
              secret
            ),
            grantTransferRequired: false,
          };
        }
        if (
          legacyCredential.pendingExpiresAt &&
          legacyCredential.pendingExpiresAt > now
        ) {
          throw new AgentIdentityError(
            "rotation_pending",
            "Legacy credential grant transfer is already running"
          );
        }
        const transferLeaseId = randomUUID();
        const pendingExpiresAt = new Date(
          now.getTime() + LEGACY_TRANSFER_LEASE_MS
        );
        await tx
          .update(agentCredentials)
          .set({
            rotationIdempotencyKey: legacyUpgradeMarker(
              fingerprint,
              transferLeaseId
            ),
            pendingExpiresAt,
          })
          .where(eq(agentCredentials.id, legacyCredential.id));
        return {
          ...this.material(
            {
              credentialId: legacyCredential.id,
              actorId: actor.id,
              billingAccountId: actor.billingAccountId,
              authenticateUntil: legacyCredential.authenticateUntil,
              renewUntil: legacyCredential.renewUntil,
            },
            secret
          ),
          grantTransferRequired: true,
          transferLeaseId,
        };
      }

      if (!actor) {
        // Legacy migration creates the same durable actor shape as spawn, so it
        // must share the billing-account ceiling. Lock the account before the
        // count/create pair; retries for an existing legacy actor remain exempt.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`agent-spawn:${billing.id}`}))`
        );
        const [active] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(actors)
          .where(
            and(
              eq(actors.kind, "agent"),
              eq(actors.billingAccountId, billing.id),
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
      const credentialId = randomUUID();
      const transferLeaseId = randomUUID();
      const authenticateUntil = new Date(now.getTime() + AUTHENTICATE_TTL_MS);
      const renewUntil = new Date(authenticateUntil.getTime() + RENEW_GRACE_MS);
      const pendingExpiresAt = new Date(
        now.getTime() + LEGACY_TRANSFER_LEASE_MS
      );
      await tx.insert(agentCredentials).values({
        id: credentialId,
        actorId: actor.id,
        nodeId: this.nodeId,
        secretHash,
        status: "pending",
        rotationIdempotencyKey: legacyUpgradeMarker(
          fingerprint,
          transferLeaseId
        ),
        authenticateUntil,
        renewUntil,
        pendingExpiresAt,
      });
      return {
        ...this.material(
          {
            credentialId,
            actorId: actor.id,
            billingAccountId: actor.billingAccountId,
            authenticateUntil,
            renewUntil,
          },
          secret
        ),
        grantTransferRequired: true,
        transferLeaseId,
      };
    });
  }

  async completeLegacyUpgrade(input: {
    legacyUserId: string;
    credentialId: string;
    transferLeaseId: string;
  }): Promise<void> {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`legacy-agent:${input.legacyUserId}`}))`
      );
      const [row] = await tx
        .select({
          credentialId: agentCredentials.id,
          credentialStatus: agentCredentials.status,
          nodeId: agentCredentials.nodeId,
          rotationIdempotencyKey: agentCredentials.rotationIdempotencyKey,
          legacyUserId: actors.legacyUserId,
        })
        .from(agentCredentials)
        .innerJoin(actors, eq(agentCredentials.actorId, actors.id))
        .where(eq(agentCredentials.id, input.credentialId))
        .limit(1);
      const marker = parseLegacyUpgradeMarker(
        row?.rotationIdempotencyKey ?? null
      );
      if (
        !row ||
        row.nodeId !== this.nodeId ||
        row.legacyUserId !== input.legacyUserId ||
        row.credentialStatus !== "pending" ||
        marker?.leaseId !== input.transferLeaseId
      ) {
        throw new AgentIdentityError(
          "invalid_credential",
          "Legacy credential transition is no longer active"
        );
      }
      await tx
        .update(agentCredentials)
        .set({ status: "active", confirmedAt: now, pendingExpiresAt: null })
        .where(eq(agentCredentials.id, row.credentialId));
    });
  }

  async releaseLegacyUpgrade(input: {
    legacyUserId: string;
    credentialId: string;
    transferLeaseId: string;
  }): Promise<void> {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`legacy-agent:${input.legacyUserId}`}))`
      );
      const [row] = await tx
        .select({
          status: agentCredentials.status,
          nodeId: agentCredentials.nodeId,
          marker: agentCredentials.rotationIdempotencyKey,
          legacyUserId: actors.legacyUserId,
        })
        .from(agentCredentials)
        .innerJoin(actors, eq(agentCredentials.actorId, actors.id))
        .where(eq(agentCredentials.id, input.credentialId))
        .limit(1);
      const marker = parseLegacyUpgradeMarker(row?.marker ?? null);
      if (
        !row ||
        row.nodeId !== this.nodeId ||
        row.legacyUserId !== input.legacyUserId ||
        row.status !== "pending" ||
        marker?.leaseId !== input.transferLeaseId
      ) {
        return;
      }
      await tx
        .update(agentCredentials)
        .set({
          rotationIdempotencyKey: legacyUpgradeMarker(
            marker.fingerprint,
            randomUUID()
          ),
          pendingExpiresAt: now,
        })
        .where(eq(agentCredentials.id, input.credentialId));
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
