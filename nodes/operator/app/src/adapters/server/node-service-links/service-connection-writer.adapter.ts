// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-service-links/service-connection-writer.adapter`
 * Purpose: Vault the X-issued key as the system tenant's `cogni-node` connection (story.0038).
 * Scope: Writes and revokes `connections` rows under the system principal's RLS scope. Reads are the
 *   broker's `resolveServiceConnection`; this adapter never returns a stored key.
 * Invariants:
 *   - ENCRYPTED_AT_REST: AEAD under CONNECTIONS_ENCRYPTION_KEY, bound data {billing_account_id: system
 *     tenant, connection_id, provider: "cogni-node", audience}; the audience binds the key to one origin.
 *   - ONE_ACTIVE_KEY_PER_AUDIENCE: the prior active row for the audience is revoked in the same
 *     transaction as the insert (the unique index allows one active row per audience).
 *   - OWNED_BY_SYSTEM_PRINCIPAL: `created_by_user_id` is the system principal, so only the broker's
 *     system-scoped read sees the row (the RLS policy keys on the creator).
 *   - SOFT_DELETE: revoke sets `revoked_at`, never deletes.
 * Side-effects: IO (database)
 * Links: packages/db-schema/src/connections.ts, drizzle-broker.adapter.ts, story.0038
 * @internal
 */

import { randomUUID } from "node:crypto";
import { withTenantScope } from "@cogni/db-client";
import { connections } from "@cogni/db-schema";
import { toUserId, userActor } from "@cogni/ids";
import {
  aeadEncrypt,
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ServiceConnectionWriterPort } from "@/ports";
import { SERVICE_CONNECTION_PROVIDER } from "../connections/drizzle-broker.adapter";

/** The X-issued key lives 30 days (node-agent-key-lifecycle). */
const KEY_LIFETIME_MS = 30 * 86_400_000;

export interface ServiceConnectionWriterConfig {
  readonly db: NodePgDatabase;
  readonly encryptionKey: Buffer;
  readonly encryptionKeyId: string;
}

export class DrizzleServiceConnectionWriter
  implements ServiceConnectionWriterPort
{
  constructor(private readonly config: ServiceConnectionWriterConfig) {}

  private scope() {
    return userActor(toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID));
  }

  private get db() {
    return this.config
      .db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
  }

  async store(input: {
    audience: string;
    apiKey: string;
    scopes: readonly string[];
  }): Promise<string> {
    const connectionId = randomUUID();
    const now = new Date();
    const encrypted = aeadEncrypt(
      JSON.stringify({ access_token: input.apiKey }),
      {
        billing_account_id: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        connection_id: connectionId,
        provider: SERVICE_CONNECTION_PROVIDER,
        audience: input.audience,
      },
      this.config.encryptionKey
    );
    await withTenantScope(this.db, this.scope(), async (tx) => {
      await tx
        .update(connections)
        .set({
          revokedAt: now,
          revokedByUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
        })
        .where(
          and(
            eq(connections.billingAccountId, COGNI_SYSTEM_BILLING_ACCOUNT_ID),
            eq(connections.provider, SERVICE_CONNECTION_PROVIDER),
            eq(connections.audience, input.audience),
            isNull(connections.revokedAt)
          )
        );
      await tx.insert(connections).values({
        id: connectionId,
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        provider: SERVICE_CONNECTION_PROVIDER,
        audience: input.audience,
        credentialType: "api_key",
        encryptedCredentials: encrypted,
        encryptionKeyId: this.config.encryptionKeyId,
        scopes: [...input.scopes],
        expiresAt: new Date(now.getTime() + KEY_LIFETIME_MS),
        createdByUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
      });
    });
    return connectionId;
  }

  async revoke(connectionId: string): Promise<void> {
    await withTenantScope(this.db, this.scope(), async (tx) => {
      await tx
        .update(connections)
        .set({
          revokedAt: new Date(),
          revokedByUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
        })
        .where(
          and(eq(connections.id, connectionId), isNull(connections.revokedAt))
        );
    });
  }
}
