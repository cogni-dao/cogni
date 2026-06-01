// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/auth/openai-codex/authorize`
 * Purpose: Initiate OpenAI Codex Device Code flow for BYO-AI.
 * Scope: Calls OpenAI device auth endpoint, returns user code + verification URL.
 *   No cookies, no redirect URI, no PKCE — works from any deployment.
 * Invariants:
 *   - TOKENS_NEVER_LOGGED: No credentials in logs
 * Side-effects: IO (HTTP request to OpenAI)
 * Links: docs/research/openai-oauth-byo-ai.md
 * @public
 */

import { EVENT_NAMES } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getServerSessionUser } from "@/lib/auth/server";
import { makeLogger } from "@/shared/observability";
import {
  byoAuthDurationMs,
  byoAuthTotal,
} from "@/shared/observability/server/metrics";

export const runtime = "nodejs";

const log = makeLogger({ component: "openai-codex-authorize" });

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const VERIFICATION_URL = "https://auth.openai.com/codex/device";

export async function POST() {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const startMs = performance.now();
  try {
    const response = await fetch(OPENAI_DEVICE_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
    });

    if (!response.ok) {
      log.error(
        {
          event: EVENT_NAMES.ADAPTER_OPENAI_DEVICE_AUTH_ERROR,
          status: response.status,
          durationMs: performance.now() - startMs,
        },
        EVENT_NAMES.ADAPTER_OPENAI_DEVICE_AUTH_ERROR
      );
      return NextResponse.json(
        { error: "Failed to start authentication" },
        { status: 502 }
      );
    }

    const data = await response.json();
    const userCode = data.user_code ?? data.usercode;
    const interval = Number(data.interval) || 5;

    if (!data.device_auth_id || !userCode) {
      log.error(
        {
          event: EVENT_NAMES.ADAPTER_OPENAI_DEVICE_AUTH_ERROR,
          reasonCode: "missing_fields",
          durationMs: performance.now() - startMs,
        },
        EVENT_NAMES.ADAPTER_OPENAI_DEVICE_AUTH_ERROR
      );
      return NextResponse.json(
        { error: "Unexpected response from OpenAI" },
        { status: 502 }
      );
    }

    const durationMs = performance.now() - startMs;
    byoAuthTotal.inc({
      route: "authorize",
      outcome: "success",
      error_code: "",
    });
    byoAuthDurationMs.observe({ route: "authorize" }, durationMs);
    log.info(
      {
        event: EVENT_NAMES.BYO_AUTH_DEVICE_CODE_COMPLETE,
        outcome: "success",
        durationMs,
      },
      EVENT_NAMES.BYO_AUTH_DEVICE_CODE_COMPLETE
    );

    return NextResponse.json({
      deviceAuthId: data.device_auth_id,
      userCode,
      interval,
      verificationUrl: VERIFICATION_URL,
    });
  } catch (err) {
    byoAuthTotal.inc({
      route: "authorize",
      outcome: "error",
      error_code: "network",
    });
    byoAuthDurationMs.observe(
      { route: "authorize" },
      performance.now() - startMs
    );
    log.error(
      {
        event: EVENT_NAMES.ADAPTER_OPENAI_DEVICE_AUTH_ERROR,
        reasonCode: "network",
        error: err instanceof Error ? err.message : String(err),
        durationMs: performance.now() - startMs,
      },
      EVENT_NAMES.ADAPTER_OPENAI_DEVICE_AUTH_ERROR
    );
    return NextResponse.json(
      { error: "Failed to connect to OpenAI" },
      { status: 502 }
    );
  }
}
