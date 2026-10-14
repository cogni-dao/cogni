// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/secrets/github-app-identity`
 * Purpose: READ-ONLY GitHub App identity probe for credential rotation: mint an
 *   App JWT from a (staged or stored) key pair, then `GET /app`,
 *   `GET /app/hook/config`, `GET /app/installations` to prove WHO the key
 *   authenticates as, where its webhooks point, and which orgs it reaches.
 * Scope: Verification only. The first `GET /app` caller in the repo (the audit
 *   found none) — deliberately fetch-based, not Octokit, so tests stay hermetic
 *   and the dependency surface stays three documented GETs.
 * Invariants:
 *   - GITHUB_IS_READ_ONLY (C1): only GET requests leave this adapter. Key mint
 *     (first) and key revocation (last, human, after propagation) are ceremony
 *     steps that never route through code. No mutation method exists.
 *   - NO_MATERIAL_ESCAPES: the PEM lives only inside `verifyAppCredential`'s
 *     frame; results carry App identity facts, never key bytes; failures are
 *     typed reasons, never upstream error bodies.
 *   - DISTINGUISH_401_FROM_TRANSPORT (C2): a GitHub 401 proves the credential is
 *     bad; a network/5xx failure proves NOTHING and must never be read as either
 *     success or credential-invalid.
 * Side-effects: IO (GitHub REST API, read-only).
 * Links: src/ports/operator-app-credentials.port.ts, subtask.5016 (C1/C2),
 *   docs/guides/github-app-webhook-setup.md
 * @public
 */

import { createSign } from "node:crypto";
import type { AppCredentialVerification, GithubAppIdentityPort } from "@/ports";
import { decodeAppPrivateKeyPem } from "@/shared/secrets/github-app-key-fingerprint";

export interface GithubAppIdentityAdapterDeps {
  /** GitHub REST base; default `https://api.github.com`. Injected in tests. */
  readonly baseUrl?: string;
  /** Defaults to global `fetch`; injected in unit tests. */
  readonly fetchImpl?: typeof fetch;
  /** Clock seam for deterministic JWT tests. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
}

interface AppResponse {
  readonly id?: number;
  readonly slug?: string;
}

interface HookConfigResponse {
  readonly url?: string;
}

interface InstallationResponse {
  readonly account?: { readonly login?: string };
}

export class GithubAppIdentityAdapter implements GithubAppIdentityPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  constructor(deps: GithubAppIdentityAdapterDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      ""
    );
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.nowMs = deps.nowMs ?? Date.now;
  }

  async verifyAppCredential(input: {
    readonly appId: string;
    readonly privateKeyBase64: string;
  }): Promise<AppCredentialVerification> {
    const pem = decodeAppPrivateKeyPem(input.privateKeyBase64);
    if (pem === null) {
      return { kind: "invalid", reason: "invalid_key_material" };
    }
    let jwt: string;
    try {
      jwt = mintAppJwt(input.appId, pem, this.nowMs());
    } catch {
      return { kind: "invalid", reason: "invalid_key_material" };
    }

    // 1) WHO does this key authenticate as?
    const appRes = await this.get("/app", jwt);
    if (appRes.kind === "transport_failure") return appRes;
    if (appRes.res.status === 401) {
      return { kind: "invalid", reason: "unauthenticated" };
    }
    if (!appRes.res.ok) {
      return { kind: "transport_failure", status: appRes.res.status };
    }
    const app = (await appRes.res.json()) as AppResponse;
    if (app.id === undefined || String(app.id) !== input.appId) {
      // The key signs FOR some App, but not the one the caller claimed — a
      // mis-staged pair. Never write it.
      return { kind: "invalid", reason: "identity_mismatch" };
    }

    // 2) Where do this App's webhooks point? (binding policy is the caller's)
    const hookRes = await this.get("/app/hook/config", jwt);
    if (hookRes.kind === "transport_failure") return hookRes;
    let webhookHost: string | null = null;
    if (hookRes.res.ok) {
      const hook = (await hookRes.res.json()) as HookConfigResponse;
      webhookHost = hostOf(hook.url);
    } else if (hookRes.res.status !== 404) {
      return { kind: "transport_failure", status: hookRes.res.status };
    }

    // 3) Which owners can this App act on? (installation reach)
    const instRes = await this.get("/app/installations?per_page=100", jwt);
    if (instRes.kind === "transport_failure") return instRes;
    if (!instRes.res.ok) {
      return { kind: "transport_failure", status: instRes.res.status };
    }
    const installations = (await instRes.res.json()) as InstallationResponse[];
    const installationOwners = installations
      .map((i) => i.account?.login)
      .filter((login): login is string => typeof login === "string");

    return {
      kind: "verified",
      appId: String(app.id),
      appSlug: app.slug ?? "",
      webhookHost,
      installationOwners,
    };
  }

  /** GET-only transport. A thrown fetch (DNS, reset, timeout) is a typed transport failure. */
  private async get(
    path: string,
    jwt: string
  ): Promise<
    | { kind: "ok"; res: Response }
    | { kind: "transport_failure"; status?: number | undefined }
  > {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      return { kind: "ok", res };
    } catch {
      return { kind: "transport_failure" };
    }
  }
}

/**
 * RS256 GitHub App JWT (iss = appId, iat backdated 60s for clock skew, 9-minute
 * expiry — inside GitHub's 10-minute cap). Pure; throws on non-RSA key material.
 */
export function mintAppJwt(appId: string, pem: string, nowMs: number): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(pem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
