// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/identity/broker-state`
 * Purpose: Carries one in-flight `identity.attestation.v1` broker request across the
 *   GitHub authorization round trip.
 * Scope: Encode/decode only. Does not read cookies, call GitHub, or sign attestations.
 * Invariants:
 *   - REQUEST_BINDING_IS_SERVER_SIDE: the node request (nodeId/nonce/targetOrigin/returnTo)
 *     is validated once at entry and then carried in a signed, HttpOnly, path-scoped cookie —
 *     never re-read from a query string on the callback leg.
 *   - SUBJECT_NEVER_FROM_SESSION: `github` is populated ONLY from the GitHub authorization
 *     response for this exact `state`. There is no operator session in this flow (task.5024).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/identity-attestation-v1, task.5024
 * @public
 */

import { decode, encode } from "next-auth/jwt";

export const BROKER_STATE_COOKIE = "identity_broker_state";
/** Scoped so the cookie is only ever sent to the broker legs. */
export const BROKER_STATE_COOKIE_PATH = "/";
const BROKER_STATE_SALT = "identity-broker-state";
/** Mirrors the link-transaction window in `api/auth/link/[provider]`. */
export const BROKER_STATE_TTL_SECONDS = 10 * 60;

export interface BrokerState {
  /**
   * Which attestable provider this round trip is for. Bound at entry and re-checked
   * on the callback leg, so a response cannot be replayed onto a different provider's
   * callback path.
   */
  readonly provider: string;
  /** CSRF/correlation value echoed by the provider. */
  readonly state: string;
  /** PKCE S256 verifier for the token exchange. */
  readonly codeVerifier: string;
  readonly nodeId: string;
  /** Human-readable node handle, shown on the confirm screen. Display only. */
  readonly nodeSlug: string;
  readonly nonce: string;
  readonly targetOrigin: string;
  readonly returnTo: string;
  /**
   * Resolved GitHub identity, present only after the callback leg has exchanged
   * the authorization code. Absent means "not yet authenticated".
   */
  readonly github?: { readonly id: string; readonly login: string | null };
}

export async function encodeBrokerState(
  state: BrokerState,
  secret: string
): Promise<string> {
  return encode({
    token: { ...state, purpose: "identity_broker" },
    secret,
    salt: BROKER_STATE_SALT,
    maxAge: BROKER_STATE_TTL_SECONDS,
  });
}

export async function decodeBrokerState(
  token: string | undefined,
  secret: string
): Promise<BrokerState | null> {
  if (!token) return null;
  let decoded: Record<string, unknown> | null;
  try {
    decoded = (await decode({
      token,
      secret,
      salt: BROKER_STATE_SALT,
    })) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!decoded || decoded.purpose !== "identity_broker") return null;

  const {
    provider,
    state,
    codeVerifier,
    nodeId,
    nodeSlug,
    nonce,
    targetOrigin,
    returnTo,
  } = decoded;
  if (
    typeof provider !== "string" ||
    typeof state !== "string" ||
    typeof codeVerifier !== "string" ||
    typeof nodeId !== "string" ||
    typeof nodeSlug !== "string" ||
    typeof nonce !== "string" ||
    typeof targetOrigin !== "string" ||
    typeof returnTo !== "string"
  ) {
    return null;
  }

  const github = decoded.github;
  let resolved: BrokerState["github"];
  if (github && typeof github === "object") {
    const { id, login } = github as Record<string, unknown>;
    if (
      typeof id === "string" &&
      (typeof login === "string" || login === null)
    ) {
      resolved = { id, login };
    } else {
      return null;
    }
  }

  return {
    provider,
    state,
    codeVerifier,
    nodeId,
    nodeSlug,
    nonce,
    targetOrigin,
    returnTo,
    ...(resolved ? { github: resolved } : {}),
  };
}
