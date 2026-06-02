// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/auth/openai-codex/exchange`
 * Purpose: Poll OpenAI device auth and exchange for tokens when authorized.
 * Scope: POST endpoint called by client on interval. If user hasn't authorized yet, returns pending.
 *   When authorized, exchanges code for tokens, encrypts and stores in connections table.
 * Invariants:
 *   - ENCRYPTED_AT_REST: Tokens stored via AEAD with AAD binding
 *   - TOKENS_NEVER_LOGGED: No tokens in logs or responses
 *   - TENANT_SCOPED: Connection belongs to authenticated user's billing account
 * Side-effects: IO (HTTP token exchange, DB insert)
 * Links: docs/research/openai-oauth-byo-ai.md, docs/spec/tenant-connections.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { withTenantScope } from "@cogni/db-client";
import { connections } from "@cogni/db-schema";
import { type UserId, userActor } from "@cogni/ids";
import { aeadEncrypt, EVENT_NAMES } from "@cogni/node-shared";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import { getServerSessionUser } from "@/lib/auth/server";
import { serverEnv } from "@/shared/env";
import { makeLogger } from "@/shared/observability";
import {
  byoAuthDurationMs,
  byoAuthTotal,
} from "@/shared/observability/server/metrics";

export const runtime = "nodejs";

const log = makeLogger({ component: "openai-codex-exchange" });

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_DEVICE_CALLBACK = "https://auth.openai.com/deviceauth/callback";

export async function POST(request: Request) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Parse request body
  let deviceAuthId: string;
  let userCode: string;
  try {
    const body = await request.json();
    deviceAuthId = body.deviceAuthId;
    userCode = body.userCode;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!deviceAuthId || !userCode) {
    return NextResponse.json(
      { error: "Missing deviceAuthId or userCode" },
      { status: 400 }
    );
  }

  const startMs = performance.now();

  // Step 1: Poll OpenAI device auth — check if user has authorized
  let authResult: {
    authorization_code: string;
    code_verifier: string;
  };

  try {
    const pollResponse = await fetch(OPENAI_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    // 403/404 = user hasn't authorized yet
    if (pollResponse.status === 403 || pollResponse.status === 404) {
      return NextResponse.json({ status: "pending" });
    }

    if (!pollResponse.ok) {
      log.error(
        { status: pollResponse.status },
        "OpenAI device token poll failed"
      );
      return NextResponse.json(
        { error: "Authorization check failed" },
        { status: 502 }
      );
    }

    authResult = await pollResponse.json();
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "OpenAI device token poll error"
    );
    return NextResponse.json(
      { error: "Failed to check authorization" },
      { status: 502 }
    );
  }

  if (!authResult.authorization_code || !authResult.code_verifier) {
    log.error(
      "Device auth response missing authorization_code or code_verifier"
    );
    return NextResponse.json(
      { error: "Unexpected authorization response" },
      { status: 502 }
    );
  }

  // Step 2: Exchange authorization code for tokens
  let tokenData: {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  try {
    const tokenResponse = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CLIENT_ID,
        code: authResult.authorization_code,
        code_verifier: authResult.code_verifier,
        redirect_uri: OPENAI_DEVICE_CALLBACK,
      }),
    });

    if (!tokenResponse.ok) {
      log.error(
        { status: tokenResponse.status },
        "OpenAI token exchange failed"
      );
      return NextResponse.json(
        { error: "Token exchange failed" },
        { status: 502 }
      );
    }

    tokenData = await tokenResponse.json();
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "OpenAI token exchange error"
    );
    return NextResponse.json(
      { error: "Token exchange failed" },
      { status: 502 }
    );
  }

  // Step 3: Extract account ID from JWT
  let accountId: string | undefined;
  try {
    const [, payloadB64] = tokenData.access_token.split(".");
    if (payloadB64) {
      const claims = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString()
      );
      accountId =
        claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? undefined;
    }
  } catch {
    // Non-fatal
  }

  // Step 4: Resolve billing account
  const container = getContainer();
  const accountService = container.accountsForUser(session.id as UserId);
  const billingAccount = await getOrCreateBillingAccountForUser(
    accountService,
    { userId: session.id }
  );

  // Step 5: Encrypt and store
  const encKeyHex = serverEnv().CONNECTIONS_ENCRYPTION_KEY;
  if (!encKeyHex) {
    log.error("CONNECTIONS_ENCRYPTION_KEY not set");
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }
  const encKey = Buffer.from(encKeyHex, "hex");
  const connectionId = randomUUID();

  const credBlob = JSON.stringify({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token ?? "",
    id_token: tokenData.id_token ?? "",
    account_id: accountId ?? "",
    ...(tokenData.expires_in
      ? {
          expires_at: new Date(
            Date.now() + tokenData.expires_in * 1000
          ).toISOString(),
        }
      : {}),
  });

  const aad = {
    billing_account_id: billingAccount.id,
    connection_id: connectionId,
    provider: "openai-chatgpt" as const,
  };
  const encrypted = aeadEncrypt(credBlob, aad, encKey);

  const db = resolveAppDb();
  try {
    // withTenantScope sets SET LOCAL app.current_user_id for RLS
    await withTenantScope(db, userActor(session.id as UserId), async (tx) => {
      await tx
        .update(connections)
        .set({ revokedAt: new Date(), revokedByUserId: session.id })
        .where(
          and(
            eq(connections.billingAccountId, billingAccount.id),
            eq(connections.provider, "openai-chatgpt"),
            isNull(connections.revokedAt)
          )
        );

      await tx.insert(connections).values({
        id: connectionId,
        billingAccountId: billingAccount.id,
        provider: "openai-chatgpt",
        credentialType: "oauth2",
        encryptedCredentials: encrypted,
        encryptionKeyId: "v1",
        scopes: ["openid", "profile", "email", "offline_access"],
        createdByUserId: session.id,
        ...(tokenData.expires_in
          ? { expiresAt: new Date(Date.now() + tokenData.expires_in * 1000) }
          : {}),
      });
    });

    const durationMs = performance.now() - startMs;
    byoAuthTotal.inc({ route: "exchange", outcome: "success", error_code: "" });
    byoAuthDurationMs.observe({ route: "exchange" }, durationMs);
    log.info(
      {
        event: EVENT_NAMES.BYO_AUTH_EXCHANGE_COMPLETE,
        connectionId,
        provider: "openai-chatgpt",
        outcome: "success",
        durationMs,
      },
      EVENT_NAMES.BYO_AUTH_EXCHANGE_COMPLETE
    );
  } catch (err) {
    byoAuthTotal.inc({
      route: "exchange",
      outcome: "error",
      error_code: "db_store",
    });
    byoAuthDurationMs.observe(
      { route: "exchange" },
      performance.now() - startMs
    );
    // Log the root cause (Postgres error), NOT the Drizzle wrapper which dumps
    // encrypted credentials in query params — TOKENS_NEVER_LOGGED violation.
    const cause =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : err instanceof Error
          ? err.message.split("\n")[0]
          : String(err);
    log.error({ error: cause }, "Failed to store connection");
    return NextResponse.json(
      { error: "Failed to store connection" },
      { status: 500 }
    );
  }

  return NextResponse.json({ status: "connected" });
}
