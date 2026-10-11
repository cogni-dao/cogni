// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-flight/node-prober`
 * Purpose: Real-fetch implementation of NodeProber — reads a node's public serving/identity surfaces
 *   and exercises its bounded governed flight-probe endpoint with a node-audienced service credential.
 * Scope: HTTP I/O, exact credential resolution, and transport-result classification only.
 * Invariants:
 *   - NO_THROWAWAY_ACTORS: run-carries never registers an agent; it calls the fixed internal probe as
 *     the target's stable `service:{nodeId}/flight-prober` principal.
 *   - EXACT_TARGET_CREDENTIAL: credential lookup is exact `{env,nodeId}` with no shared fallback.
 *   - RUN_CARRIES_IS_TRUTH: a contract-valid response names the created run. A downstream graph error
 *     is degraded; a timeout, missing credential, auth rejection, or malformed response is fail.
 *   - IDENTITY_IS_ZOD_PARSED: the well-known `identity` block is parsed defensively — a node not yet
 *     projecting identity returns generic JSON with no `identity` ⇒ `null` (never a throw), and a malformed
 *     block degrades to null rather than corrupting a gallery card.
 *   - THUMBNAIL_RESOLVED_TO_HOST: the node publishes a host-relative thumbnail PATH; this adapter joins it
 *     against `https://<host>` so the image loads from the node's OWN env host (no cross-env / CDN leak).
 * Side-effects: network I/O
 * Links: src/features/nodes/flight-status.ts, docs/guides/agent-api-validation.md,
 *   src/app/.well-known/agent.json/route.ts (the projection this reads)
 * @public
 */

import { InternalFlightProbeOutputSchema } from "@cogni/node-contracts";
import { z } from "zod";
import type {
  FlightProbeCredentialResolver,
  FlightProbeTarget,
  NodeIdentity,
  NodeProber,
  RunCarriesResult,
  ServingResult,
} from "@/ports";

const SERVING_TIMEOUT_MS = 10_000;
/** The hang we hunt is ~60s; give a touch of headroom so a real hang reads as a timeout, not a probe abort. */
const RUN_CARRIES_TIMEOUT_MS = 70_000;

/**
 * Defensive schema for the well-known `identity` block. Every field is optional/nullable: a node that
 * has not projected identity omits the whole block (the wrapping `.identity` is `.optional()` at the
 * call site), and a partially-declared node leaves individual fields null. Unknown sibling keys are
 * ignored — this only pins the shape the gallery consumes.
 */
const wellKnownIdentitySchema = z.object({
  name: z.string(),
  hook: z.string().nullable().optional(),
  mission: z.string().nullable().optional(),
  brand: z
    .object({
      icon: z.string().nullable().optional(),
      thumbnail: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
    })
    .optional(),
});

/** Resolve a host-relative thumbnail PATH against the node's own host → absolute, so it loads per-env. */
function resolveThumbnail(
  thumbnail: string | null | undefined,
  host: string
): string | null {
  if (!thumbnail) return null;
  try {
    // `new URL` leaves an already-absolute URL intact and joins a relative path against the host base.
    return new URL(thumbnail, `https://${host}`).toString();
  } catch {
    return null;
  }
}

/** True when a `brand.icon` value is an image asset (path/URL) rather than a Lucide icon NAME. */
function isAssetPath(icon: string): boolean {
  return /^(https?:\/\/|\/)/.test(icon);
}

/**
 * `brand.icon` is polymorphic: a Lucide icon NAME (e.g. `Gamepad2`) OR an image asset the node hosts
 * (e.g. `/TransparentBrainOnly.png` — a real logo). Names pass through verbatim; image paths are
 * host-resolved to an absolute URL so the gallery loads them per-env. The consumer renders a name via
 * the Lucide registry and a URL via `<img>`.
 */
function resolveIcon(
  icon: string | null | undefined,
  host: string
): string | null {
  if (!icon) return null;
  return isAssetPath(icon) ? resolveThumbnail(icon, host) : icon;
}

/**
 * Pure parser for a well-known document → NodeIdentity (exported for unit tests). Returns `null` when
 * the document has no valid `identity` block. `brand.thumbnail` is resolved to an absolute URL against
 * `host`; every undeclared field collapses to `null`.
 */
export function parseWellKnownIdentity(
  body: unknown,
  host: string
): NodeIdentity | null {
  if (!body || typeof body !== "object" || !("identity" in body)) return null;
  const parsed = wellKnownIdentitySchema.safeParse(
    (body as { identity: unknown }).identity
  );
  if (!parsed.success) return null;
  const id = parsed.data;
  return {
    name: id.name,
    hook: id.hook ?? null,
    mission: id.mission ?? null,
    brand: {
      icon: resolveIcon(id.brand?.icon, host),
      thumbnail: resolveThumbnail(id.brand?.thumbnail, host),
      color: id.brand?.color ?? null,
    },
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function readBuildSha(body: unknown): string | null {
  if (body && typeof body === "object" && "buildSha" in body) {
    const v = (body as { buildSha?: unknown }).buildSha;
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  return null;
}

export class HttpNodeProber implements NodeProber {
  constructor(
    private readonly credentialResolver: FlightProbeCredentialResolver
  ) {}

  async serving(host: string): Promise<ServingResult> {
    let readyzCode = 0;
    try {
      const r = await fetchWithTimeout(
        `https://${host}/readyz`,
        { method: "GET" },
        SERVING_TIMEOUT_MS
      );
      readyzCode = r.status;
    } catch {
      readyzCode = 0; // network error / timeout / edge 5xx that never connected
    }

    let buildSha: string | null = null;
    try {
      const r = await fetchWithTimeout(
        `https://${host}/version`,
        { method: "GET" },
        SERVING_TIMEOUT_MS
      );
      if (r.ok) buildSha = readBuildSha(await r.json());
    } catch {
      buildSha = null;
    }

    const status = readyzCode === 200 ? "pass" : "fail";
    return { status, readyzCode, buildSha };
  }

  async identity(host: string): Promise<NodeIdentity | null> {
    try {
      const r = await fetchWithTimeout(
        `https://${host}/.well-known/agent.json`,
        { method: "GET" },
        SERVING_TIMEOUT_MS
      );
      if (!r.ok) return null;
      return parseWellKnownIdentity(await r.json(), host);
    } catch {
      // Unreachable host / non-JSON body ⇒ no identity (the gallery degrades to a titleCase monogram).
      return null;
    }
  }

  async runCarries(target: FlightProbeTarget): Promise<RunCarriesResult> {
    const credential = this.credentialResolver.resolve(target);
    if (!credential) {
      return {
        status: "fail",
        durationMs: 0,
        runs: 0,
        detail: "probe-credential-missing",
      };
    }

    const start = Date.now();
    try {
      const resp = await fetchWithTimeout(
        `https://${target.host}/api/internal/flight-probe`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.apiKey}`,
          },
        },
        RUN_CARRIES_TIMEOUT_MS
      );
      const durationMs = Date.now() - start;
      if (!resp.ok) {
        return {
          status: "fail",
          durationMs,
          runs: 0,
          detail: `probe-http-${resp.status}`,
        };
      }
      const parsed = InternalFlightProbeOutputSchema.safeParse(
        await resp.json()
      );
      if (!parsed.success) {
        return {
          status: "fail",
          durationMs,
          runs: 0,
          detail: "probe-invalid-response",
        };
      }
      const expectedPrincipalId = `service:${target.nodeId}/flight-prober`;
      if (parsed.data.principalId !== expectedPrincipalId) {
        return {
          status: "fail",
          durationMs,
          runs: 0,
          detail: "probe-principal-mismatch",
        };
      }
      return {
        status: parsed.data.ok ? "pass" : "degraded",
        durationMs,
        runs: 1,
        detail: parsed.data.ok ? "probe-complete" : "graph-error",
      };
    } catch {
      return {
        status: "fail",
        durationMs: Date.now() - start,
        runs: 0,
        detail: "hang:no-run",
      };
    }
  }
}
