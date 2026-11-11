// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-service-links/enrollment-transport.adapter`
 * Purpose: Call node X's public enrollment routes: post the signed token, poll the device code, confirm
 *   the stored key (story.0038). Wire: node-service-enrollment, Question 2.
 * Scope: Three bounded HTTPS calls to the registered origin. No retries, no storage, no logging.
 * Invariants:
 *   - HTTPS_ONLY_STORED_ORIGIN: the origin is the registry-resolved audience; only `https` is called and
 *     redirects are never followed (`redirect: manual`).
 *   - BOUNDED: 10 s timeout and a 64 KiB response cap per call.
 *   - RFC8628_ERRORS: poll errors `authorization_pending`, `slow_down`, `access_denied`, `expired_token`
 *     map to typed results; an unknown error is `bad_response`.
 *   - NOTHING_SECRET_LOGGED: this module never logs a token, device code, JWE or key.
 * Side-effects: IO (HTTPS to node X)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038
 * @internal
 */

import {
  type EnrollmentAccepted,
  type EnrollmentPollResult,
  EnrollmentTransportError,
  type NodeEnrollmentTransportPort,
} from "@/ports";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const ENROLL_PATH = "/api/v1/public/agent/service-enrollments";
const TOKEN_PATH = "/api/v1/public/agent/service-enrollments/token";
const CONFIRM_PATH = "/api/v1/agent/credentials/confirm";

async function call(
  origin: string,
  path: string,
  init: { body?: unknown; bearer?: string }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(path, origin);
  if (url.protocol !== "https:" || url.origin !== new URL(origin).origin) {
    throw new EnrollmentTransportError("origin_unreachable");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: JSON.stringify(init.body ?? {}),
    });
  } catch {
    throw new EnrollmentTransportError("origin_unreachable");
  }
  if (response.status >= 500) {
    throw new EnrollmentTransportError("origin_unreachable", response.status);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  let json: Record<string, unknown> = {};
  if (buffer.length > 0 && buffer.length <= MAX_RESPONSE_BYTES) {
    try {
      const parsed: unknown = JSON.parse(buffer.toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      /* non-JSON body: handled by the caller from the status */
    }
  }
  return { status: response.status, json };
}

const num = (...vals: unknown[]): number | undefined =>
  vals.find((v): v is number => typeof v === "number" && Number.isFinite(v));
const str = (...vals: unknown[]): string | undefined =>
  vals.find((v): v is string => typeof v === "string" && v.length > 0);

export class HttpNodeEnrollmentTransport
  implements NodeEnrollmentTransportPort
{
  async postEnrollment(
    origin: string,
    token: string
  ): Promise<EnrollmentAccepted> {
    const { status, json } = await call(origin, ENROLL_PATH, {
      body: { token },
    });
    if (status === 401) {
      const code = str(json.errorCode, json.error);
      throw new EnrollmentTransportError(
        code === "replayed_token" ? "replayed_token" : "enrollment_rejected",
        status
      );
    }
    if (status < 200 || status >= 300) {
      throw new EnrollmentTransportError("enrollment_rejected", status);
    }
    const deviceCode = str(json.deviceCode, json.device_code);
    if (!deviceCode) throw new EnrollmentTransportError("bad_response", status);
    return {
      deviceCode,
      expiresInS: num(json.expires_in, json.expiresIn) ?? 86_400,
      intervalS: num(json.interval) ?? 5,
    };
  }

  async pollToken(
    origin: string,
    deviceCode: string
  ): Promise<EnrollmentPollResult> {
    const { status, json } = await call(origin, TOKEN_PATH, {
      body: { deviceCode },
    });
    const sealedKey = str(
      json.sealedKey,
      json.sealed_key,
      json.jwe,
      json.keyJwe
    );
    if (status >= 200 && status < 300 && sealedKey) {
      return { kind: "issued", sealedKey };
    }
    const error = str(json.error, json.errorCode);
    if (
      error === "authorization_pending" ||
      error === "slow_down" ||
      error === "access_denied" ||
      error === "expired_token"
    ) {
      return { kind: error };
    }
    throw new EnrollmentTransportError("bad_response", status);
  }

  async confirmKey(origin: string, apiKey: string) {
    const { status } = await call(origin, CONFIRM_PATH, { bearer: apiKey });
    return { ok: status === 200, status };
  }
}
