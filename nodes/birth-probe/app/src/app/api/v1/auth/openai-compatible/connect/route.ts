// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/auth/openai-compatible/connect`
 * Purpose: Connect a user-hosted OpenAI-compatible LLM endpoint (Ollama, vLLM, etc.).
 * Scope: POST endpoint. Accepts endpoint URL + optional API key, validates reachability
 *   via GET /v1/models, encrypts credentials, stores in connections table. Does not handle
 *   SSRF validation (TODO for production).
 * Invariants:
 *   - ENCRYPTED_AT_REST: Credentials stored via AEAD encryption with AAD binding
 *   - TENANT_SCOPED: Connection belongs to authenticated user's billing account
 *   - SOFT_DELETE: Revokes previous active connection for same provider before inserting
 *   - TOKENS_NEVER_LOGGED: Endpoint URL and API key never appear in logs
 * Side-effects: IO (HTTP probe to user endpoint, DB insert)
 * Links: docs/spec/tenant-connections.md, docs/spec/multi-provider-llm.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { withTenantScope } from "@cogni/db-client";
import { connections } from "@cogni/db-schema";
import { type UserId, userActor } from "@cogni/ids";
import { aeadEncrypt } from "@cogni/node-shared";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import { getServerSessionUser } from "@/lib/auth/server";
import { serverEnv } from "@/shared/env/server";
import { makeLogger } from "@/shared/observability";

export const runtime = "nodejs";

const log = makeLogger({ component: "openai-compatible-connect" });

const ConnectInputSchema = z.object({
  endpointUrl: z
    .string()
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
      message: "Must be an HTTP or HTTPS URL",
    }),
  apiKey: z.string().min(1, "API key is required for secure connections"),
});

export async function POST(request: Request) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Parse input
  let input: z.infer<typeof ConnectInputSchema>;
  try {
    const body = await request.json();
    input = ConnectInputSchema.parse(body);
  } catch {
    return NextResponse.json(
      {
        error: "Invalid input. Provide endpointUrl (URL) and optional apiKey.",
      },
      { status: 400 }
    );
  }

  // Strip trailing slash from endpoint URL
  const baseUrl = input.endpointUrl.replace(/\/+$/, "");

  // Probe endpoint: GET /v1/models to verify reachability
  let modelCount = 0;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.apiKey}`,
    };
    const probe = await fetch(`${baseUrl}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!probe.ok) {
      return NextResponse.json(
        { error: `Endpoint returned ${probe.status}. Check URL and API key.` },
        { status: 422 }
      );
    }
    const data = (await probe.json()) as { data?: unknown[] };
    modelCount = data.data?.length ?? 0;
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "Cannot reach endpoint. Ensure your server is running and accessible.",
        detail: err instanceof Error ? err.message : undefined,
      },
      { status: 422 }
    );
  }

  // Resolve billing account
  const container = getContainer();
  const accountService = container.accountsForUser(session.id as UserId);
  const billingAccount = await getOrCreateBillingAccountForUser(
    accountService,
    { userId: session.id }
  );

  // Encryption setup
  const env = serverEnv();
  const encryptionKey = env.CONNECTIONS_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return NextResponse.json(
      { error: "BYO-AI not configured on this instance" },
      { status: 503 }
    );
  }
  const keyBuf = Buffer.from(encryptionKey, "hex");

  const connectionId = randomUUID();
  const provider = "openai-compatible";

  // Build credential blob (same shape as other providers)
  // accessToken = baseUrl, accountId = apiKey (reusing existing CredentialBlob shape)
  const credentialBlob = JSON.stringify({
    access_token: baseUrl,
    ...(input.apiKey ? { account_id: input.apiKey } : {}),
  });

  const aad = {
    billing_account_id: billingAccount.id,
    connection_id: connectionId,
    provider,
  };
  const encrypted = aeadEncrypt(credentialBlob, aad, keyBuf);

  const db = resolveAppDb();
  try {
    await withTenantScope(db, userActor(session.id as UserId), async (tx) => {
      // Revoke previous active connection for this provider
      await tx
        .update(connections)
        .set({ revokedAt: new Date(), revokedByUserId: session.id })
        .where(
          and(
            eq(connections.billingAccountId, billingAccount.id),
            eq(connections.provider, provider),
            isNull(connections.revokedAt)
          )
        );

      // Insert new connection
      await tx.insert(connections).values({
        id: connectionId,
        billingAccountId: billingAccount.id,
        provider,
        credentialType: "api_key",
        encryptedCredentials: encrypted,
        encryptionKeyId: "v1",
        scopes: [],
        createdByUserId: session.id,
      });
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to store connection"
    );
    return NextResponse.json(
      { error: "Failed to store connection" },
      { status: 500 }
    );
  }

  log.info(
    { billingAccountId: billingAccount.id, modelCount },
    "OpenAI-compatible endpoint connected"
  );

  return NextResponse.json({
    ok: true,
    connectionId,
    modelCount,
  });
}
