// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/auth/attest/confirm`
 * Purpose: Terminal leg — the human confirmed the resolved GitHub account, so sign the
 *   attestation and hand it to the exact registered node origin. Also handles
 *   "use a different account" and "cancel".
 * Scope: Reads the broker cookie, signs, clears the cookie, redirects. Never re-reads
 *   the subject from anywhere else.
 * Invariants:
 *   - CONFIRM_BEFORE_SIGN: reachable only by an explicit POST from the confirm screen.
 *   - TERMINAL_COOKIE_CLEAR: terminal responses clear the browser cookie; the relying
 *     node atomically consumes its nonce when binding.
 *   - SWITCH_RE_AUTHENTICATES: "use a different account" restarts the GitHub leg with a
 *     fresh state + PKCE pair rather than reusing the previous authentication.
 *   - SITS_WITH_NEXTAUTH: unauthenticated by design — its authority is the signed
 *     broker cookie, never an operator session — and placed beside NextAuth's own
 *     callback so one registered OAuth callback prefix covers both.
 * Side-effects: IO (registry read, signing, cookie clear, redirect)
 * @public
 */

import {
  IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  IdentityAttestationRequestSchema,
} from "@cogni/node-contracts";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AttestationBrokerError,
  issueBrowserIdentityAttestation,
} from "@/app/_facades/identity/attestation-broker.server";
import { authSecret } from "@/auth";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import {
  brokerRedirectUri,
  brokerUrl,
  isAttestableProvider,
  resolveGithubOauthClient,
} from "@/shared/identity/broker-config";
import {
  BROKER_STATE_COOKIE,
  BROKER_STATE_COOKIE_PATH,
  BROKER_STATE_TTL_SECONDS,
  decodeBrokerState,
  encodeBrokerState,
} from "@/shared/identity/broker-state";
import {
  buildGithubAuthorizeUrl,
  createAuthorizationChallenge,
} from "@/shared/identity/github-oauth";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Broker observability. These are the tier-1 markers `/validate-candidate` queries;
 * without them the broker is invisible in Loki and the feature cannot be proven at a
 * SHA. Deliberately NEVER logged: the authorization code, the access token, the PKCE
 * verifier, and the broker cookie. Confirmation logs contain fixed categories and the
 * signed request node identifier only.
 */
function brokerLog(): ReturnType<typeof makeLogger> {
  return makeLogger({ nodeId: getNodeId(), service: "identity-broker" });
}

function failure(errorCode: string, requestNodeId?: string): NextResponse {
  brokerLog().info(
    {
      event: EVENT_NAMES.IDENTITY_BROKER_REJECTED,
      leg: "confirm",
      errorCode,
      ...(requestNodeId ? { requestNodeId } : {}),
    },
    "Identity broker confirmation rejected"
  );
  return NextResponse.redirect(
    brokerUrl(
      serverEnv(),
      `/identity/attest/error?code=${encodeURIComponent(errorCode)}`
    ),
    { status: 303 }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const cookieStore = await cookies();
  const brokerState = await decodeBrokerState(
    cookieStore.get(BROKER_STATE_COOKIE)?.value,
    authSecret
  );
  if (!brokerState?.github) {
    return failure("broker_request_expired");
  }

  const form = await request.formData().catch(() => null);
  const actions = form?.getAll("action") ?? [];
  const action =
    actions.length === 1 && typeof actions[0] === "string" ? actions[0] : null;
  const env = serverEnv();

  if (action !== "confirm" && action !== "switch" && action !== "cancel") {
    cookieStore.delete(BROKER_STATE_COOKIE);
    return failure("invalid_request", brokerState.nodeId);
  }

  if (action === "switch") {
    if (!isAttestableProvider(brokerState.provider)) {
      cookieStore.delete(BROKER_STATE_COOKIE);
      return failure("invalid_request");
    }
    const provider = brokerState.provider;
    // Re-authenticate from scratch: fresh state + PKCE, no carried-over identity.
    const client = resolveGithubOauthClient(env);
    if (!client) {
      cookieStore.delete(BROKER_STATE_COOKIE);
      return failure("attestation_unavailable");
    }
    const challenge = createAuthorizationChallenge();
    cookieStore.set(
      BROKER_STATE_COOKIE,
      await encodeBrokerState(
        {
          provider: brokerState.provider,
          state: challenge.state,
          codeVerifier: challenge.codeVerifier,
          nodeId: brokerState.nodeId,
          nodeSlug: brokerState.nodeSlug,
          nonce: brokerState.nonce,
          targetOrigin: brokerState.targetOrigin,
          returnTo: brokerState.returnTo,
        },
        authSecret
      ),
      {
        httpOnly: true,
        secure: env.isProd,
        sameSite: "lax",
        path: BROKER_STATE_COOKIE_PATH,
        maxAge: BROKER_STATE_TTL_SECONDS,
      }
    );
    return NextResponse.redirect(
      buildGithubAuthorizeUrl({
        clientId: client.clientId,
        redirectUri: brokerRedirectUri(env, provider),
        state: challenge.state,
        codeChallenge: challenge.codeChallenge,
      }),
      { status: 303 }
    );
  }

  cookieStore.delete(BROKER_STATE_COOKIE);

  if (action !== "confirm") {
    return failure("cancelled", brokerState.nodeId);
  }

  const parsed = IdentityAttestationRequestSchema.safeParse({
    protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
    nodeId: brokerState.nodeId,
    nonce: brokerState.nonce,
    targetOrigin: brokerState.targetOrigin,
  });
  if (!parsed.success) {
    return failure("invalid_request");
  }

  try {
    const issued = await issueBrowserIdentityAttestation({
      github: brokerState.github,
      request: parsed.data,
      returnTo: brokerState.returnTo,
    });
    brokerLog().info(
      {
        event: EVENT_NAMES.IDENTITY_BROKER_COMPLETE,
        requestNodeId: brokerState.nodeId,
        action: "confirm",
      },
      "Identity broker issued an attestation for a human-confirmed GitHub account"
    );

    return NextResponse.redirect(issued.redirectUrl, { status: 303 });
  } catch (error) {
    if (error instanceof AttestationBrokerError) {
      return failure(error.code);
    }
    throw error;
  }
}
