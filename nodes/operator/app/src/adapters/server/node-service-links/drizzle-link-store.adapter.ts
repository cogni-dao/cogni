// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-service-links/drizzle-link-store.adapter`
 * Purpose: Drizzle store for `node_service_links` (story.0038). Service-role db: the table is
 *   deny-all to the app role (ENABLE + FORCE RLS, no policy).
 * Scope: Row reads and writes plus AEAD of the two poll secrets. Does not call X or vault a key.
 * Invariants:
 *   - NO_PLAINTEXT_AT_REST: the device code and the private JWK are AEAD-encrypted under
 *     CONNECTIONS_ENCRYPTION_KEY with bound data {billing_account_id: system tenant, connection_id:
 *     link id, provider: "node_service_link"}; both columns are nulled when the link leaves `pending`.
 *   - ONE_OPEN_LINK_PER_NODE_SERVICE: the partial unique index is the guard; a violation maps to
 *     OpenServiceLinkExistsError.
 *   - POLL_SLOT_IS_ATOMIC: `claimPoll` is one conditional UPDATE, so two steps cannot both poll X.
 * Side-effects: IO (database)
 * Links: nodes/operator/app/src/shared/db/node-service-links.ts, story.0038
 * @internal
 */

import type { Database } from "@cogni/db-client";
import type {
  NodeServiceLinkStateValue,
  NodeServiceName,
} from "@cogni/node-contracts";
import {
  aeadDecrypt,
  aeadEncrypt,
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
} from "@cogni/node-shared";
import { and, count, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import {
  type NewNodeServiceLink,
  type NodeServiceLinkRecord,
  type NodeServiceLinkStorePort,
  OpenServiceLinkExistsError,
} from "@/ports";
import { nodeServiceLinks } from "@/shared/db/schema";

export interface DrizzleNodeServiceLinkStoreConfig {
  /** Service-role database (BYPASSRLS). */
  readonly db: Database;
  readonly encryptionKey: Buffer;
  readonly encryptionKeyId: string;
}

type Row = typeof nodeServiceLinks.$inferSelect;

const AEAD_PROVIDER = "node_service_link";

function toRecord(row: Row): NodeServiceLinkRecord {
  return {
    id: row.id,
    nodeId: row.nodeId,
    service: row.service as NodeServiceName,
    audience: row.audience,
    state: row.state as NodeServiceLinkStateValue,
    requestedByUserId: row.requestedByUserId,
    jti: row.jti,
    pollIntervalS: row.pollIntervalS,
    lastPolledAt: row.lastPolledAt,
    deviceCodeExpiresAt: row.deviceCodeExpiresAt,
    connectionId: row.connectionId,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
    connectedAt: row.connectedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

export class DrizzleNodeServiceLinkStore implements NodeServiceLinkStorePort {
  constructor(private readonly config: DrizzleNodeServiceLinkStoreConfig) {}

  private aad(linkId: string) {
    return {
      billing_account_id: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
      connection_id: linkId,
      provider: AEAD_PROVIDER,
    };
  }

  async insert(input: NewNodeServiceLink): Promise<NodeServiceLinkRecord> {
    const id = crypto.randomUUID();
    const { encryptionKey } = this.config;
    try {
      const rows = await this.config.db
        .insert(nodeServiceLinks)
        .values({
          id,
          nodeId: input.nodeId,
          service: input.service,
          audience: input.audience,
          requestedByUserId: input.requestedByUserId,
          jti: input.jti,
          deviceCodeEnc: aeadEncrypt(
            input.deviceCode,
            this.aad(id),
            encryptionKey
          ),
          cnfPrivateKeyEnc: aeadEncrypt(
            JSON.stringify(input.cnfPrivateJwk),
            this.aad(id),
            encryptionKey
          ),
          encryptionKeyId: this.config.encryptionKeyId,
          pollIntervalS: input.pollIntervalS,
          deviceCodeExpiresAt: input.deviceCodeExpiresAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("node_service_link_insert_empty");
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new OpenServiceLinkExistsError();
      throw error;
    }
  }

  async findById(id: string): Promise<NodeServiceLinkRecord | null> {
    const rows = await this.config.db
      .select()
      .from(nodeServiceLinks)
      .where(eq(nodeServiceLinks.id, id))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findOpen(
    nodeId: string,
    service: NodeServiceName
  ): Promise<NodeServiceLinkRecord | null> {
    const rows = await this.config.db
      .select()
      .from(nodeServiceLinks)
      .where(
        and(
          eq(nodeServiceLinks.nodeId, nodeId),
          eq(nodeServiceLinks.service, service),
          inArray(nodeServiceLinks.state, ["pending", "connected"])
        )
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findConnectedByAudience(
    audience: string,
    service: NodeServiceName
  ): Promise<NodeServiceLinkRecord | null> {
    const rows = await this.config.db
      .select()
      .from(nodeServiceLinks)
      .where(
        and(
          eq(nodeServiceLinks.audience, audience),
          eq(nodeServiceLinks.service, service),
          eq(nodeServiceLinks.state, "connected")
        )
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async readSecrets(id: string) {
    const rows = await this.config.db
      .select({
        deviceCodeEnc: nodeServiceLinks.deviceCodeEnc,
        cnfPrivateKeyEnc: nodeServiceLinks.cnfPrivateKeyEnc,
        state: nodeServiceLinks.state,
      })
      .from(nodeServiceLinks)
      .where(eq(nodeServiceLinks.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.state !== "pending") return null;
    if (!row.deviceCodeEnc || !row.cnfPrivateKeyEnc) return null;
    const { encryptionKey } = this.config;
    return {
      deviceCode: aeadDecrypt(row.deviceCodeEnc, this.aad(id), encryptionKey),
      cnfPrivateJwk: JSON.parse(
        aeadDecrypt(row.cnfPrivateKeyEnc, this.aad(id), encryptionKey)
      ) as Record<string, unknown>,
    };
  }

  async claimPoll(id: string, now: Date, minGapMs: number): Promise<boolean> {
    const rows = await this.config.db
      .update(nodeServiceLinks)
      .set({ lastPolledAt: now, updatedAt: now })
      .where(
        and(
          eq(nodeServiceLinks.id, id),
          eq(nodeServiceLinks.state, "pending"),
          or(
            isNull(nodeServiceLinks.lastPolledAt),
            lte(
              nodeServiceLinks.lastPolledAt,
              new Date(now.getTime() - minGapMs)
            )
          )
        )
      )
      .returning({ id: nodeServiceLinks.id });
    return rows.length === 1;
  }

  async setPollInterval(id: string, pollIntervalS: number): Promise<void> {
    await this.config.db
      .update(nodeServiceLinks)
      .set({ pollIntervalS, updatedAt: new Date() })
      .where(eq(nodeServiceLinks.id, id));
  }

  async markConnected(id: string, connectionId: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.config.db
      .update(nodeServiceLinks)
      .set({
        state: "connected",
        connectionId,
        failureCode: null,
        deviceCodeEnc: null,
        cnfPrivateKeyEnc: null,
        connectedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(nodeServiceLinks.id, id),
          eq(nodeServiceLinks.state, "pending")
        )
      )
      .returning({ id: nodeServiceLinks.id });
    return rows.length === 1;
  }

  async markState(
    id: string,
    state: Exclude<NodeServiceLinkStateValue, "pending" | "connected">,
    failureCode?: string
  ): Promise<void> {
    await this.config.db
      .update(nodeServiceLinks)
      .set({
        state,
        failureCode: failureCode ?? null,
        deviceCodeEnc: null,
        cnfPrivateKeyEnc: null,
        updatedAt: new Date(),
      })
      .where(eq(nodeServiceLinks.id, id));
  }

  async countStartsSince(userId: string, since: Date): Promise<number> {
    const rows = await this.config.db
      .select({ n: count() })
      .from(nodeServiceLinks)
      .where(
        and(
          eq(nodeServiceLinks.requestedByUserId, userId),
          gte(nodeServiceLinks.createdAt, since)
        )
      );
    return Number(rows[0]?.n ?? 0);
  }
}
