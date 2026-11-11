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
 *   - REAL_SIZE_CAP: the 64 KiB cap is enforced while reading; X's answers are parsed with zod and its
 *     interval and expiry are clamped.
 *   - NOTHING_SECRET_LOGGED: this module never logs a token, device code, JWE or key.
 * Side-effects: IO (HTTPS to node X)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038
 * @internal
 */

import { z } from "zod";
import { readBoundedBody } from "./bounded-body";
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
  let json: Record<string, unknown> = {};
  try {
    const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    if (!body.ok) throw new EnrollmentTransportError("bad_response", response.status);
    if (body.bytes.length > 0) {
      const parsed: unknown = JSON.parse(body.bytes.toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    }
  } catch (error) {
    if (error instanceof EnrollmentTransportError) throw error;
    // A stream failure or a non-JSON body: the status alone decides.
    json = {};
  }
  return { status: response.status, json };
}

/** X's answer to the signed token: camelCase `deviceCode`, RFC 8628 `expires_in` and `interval` (design text). */
const AcceptedSchema = z.object({
  deviceCode: z.string().min(1).max(512),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
const IssuedSchema = z.object({ sealedKey: z.string().min(1).max(16_384) });
const PollErrorSchema = z.object({
  error: z.enum([
    "authorization_pending",
    "slow_down",
    "access_denied",
    "expired_token",
  ]),
});

/** The device code lives at most 24 h (design); X's interval is bounded so a hostile X cannot stall or flood polls. */
const MAX_EXPIRES_IN_S = 86_400;
const MIN_EXPIRES_IN_S = 60;
const MIN_INTERVAL_S = 5;
const MAX_INTERVAL_S = 60;
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

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
      const code = typeof json.error === "string" ? json.error : json.errorCode;
      throw new EnrollmentTransportError(
        code === "replayed_token" ? "replayed_token" : "enrollment_rejected",
        status
      );
    }
    if (status < 200 || status >= 300) {
      throw new EnrollmentTransportError("enrollment_rejected", status);
    }
    const accepted = AcceptedSchema.safeParse(json);
    if (!accepted.success) {
      throw new EnrollmentTransportError("bad_response", status);
    }
    return {
      deviceCode: accepted.data.deviceCode,
      expiresInS: clamp(
        accepted.data.expires_in,
        MIN_EXPIRES_IN_S,
        MAX_EXPIRES_IN_S
      ),
      intervalS: clamp(accepted.data.interval, MIN_INTERVAL_S, MAX_INTERVAL_S),
    };
  }

  async pollToken(
    origin: string,
    deviceCode: string
  ): Promise<EnrollmentPollResult> {
    const { status, json } = await call(origin, TOKEN_PATH, {
      body: { deviceCode },
    });
    const issued = IssuedSchema.safeParse(json);
    if (status >= 200 && status < 300 && issued.success) {
      return { kind: "issued", sealedKey: issued.data.sealedKey };
    }
    const failure = PollErrorSchema.safeParse(json);
    if (failure.success) return { kind: failure.data.error };
    throw new EnrollmentTransportError("bad_response", status);
  }

  async confirmKey(origin: string, apiKey: string) {
    const { status } = await call(origin, CONFIRM_PATH, { bearer: apiKey });
    return { ok: status === 200, status };
  }
}
