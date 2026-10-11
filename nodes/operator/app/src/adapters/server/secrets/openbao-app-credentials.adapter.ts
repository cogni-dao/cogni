// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/secrets/openbao-app-credentials`
 * Purpose: OpenBao custody for the operator's own GitHub App credential pair
 *   (`GH_REVIEW_APP_ID` + `GH_REVIEW_APP_PRIVATE_KEY_BASE64` at
 *   `cogni/<env>/operator`). Pod projected-SA self-login (same identity as
 *   `OpenBaoSecretsAdapter`), then: read → non-secret fingerprints only;
 *   write → ONE KV-v2 request carrying BOTH keys with check-and-set (C4).
 * Scope: The operator bucket only — the `operator` path segment is a module
 *   constant, so no caller input can retarget a node namespace.
 * Invariants:
 *   - SELF_LOGIN: the pod authenticates with its projected SA token; no caller creds.
 *   - ATOMIC_PAIR_CAS: both keys in one PATCH/PUT with `options.cas`; a concurrent
 *     version bump fails typed (`openbao_cas_conflict`), never interleaves.
 *   - PATCH_PRESERVES_SIBLINGS: existing bucket → merge-patch; other keys at
 *     `cogni/<env>/operator` are untouched.
 *   - FINGERPRINTS_NOT_VALUES: `readStoredAppCredentialPair` derives the public-key
 *     SHA-256 in-process and discards the material; no result carries key bytes.
 * Side-effects: IO (projected SA token file via injected reader; OpenBao HTTP API).
 * Links: src/ports/operator-app-credentials.port.ts,
 *   src/adapters/server/secrets/openbao-secrets.adapter.ts (the sibling this mirrors),
 *   docs/spec/secrets-management.md (Invariants 4, 7), subtask.5016
 * @public
 */

import type {
  OperatorAppCredentialsStorePort,
  StoredAppCredentialPair,
  WriteAppCredentialPairInput,
  WriteAppCredentialPairResult,
} from "@/ports";
import { fingerprintAppPrivateKeyBase64 } from "@/shared/secrets/github-app-key-fingerprint";

/** The one bucket this adapter may address — a constant, never caller input. */
const OPERATOR_BUCKET = "operator";
const APP_ID_KEY = "GH_REVIEW_APP_ID";
const PRIVATE_KEY_KEY = "GH_REVIEW_APP_PRIVATE_KEY_BASE64";

export interface OpenBaoAppCredentialsAdapterDeps {
  /** OpenBao ClusterIP base, e.g. `http://openbao.openbao.svc:8200`. */
  readonly addr: string;
  /** k8s-auth role bound to the operator-secrets-writer SA (read+write on the lane). */
  readonly role: string;
  /** Reads the pod's projected SA token (`audience: cogni-openbao`). Injected for testability. */
  readonly readServiceAccountToken: () => Promise<string>;
  /** Defaults to global `fetch`; injected in unit tests. */
  readonly fetchImpl?: typeof fetch;
}

interface KvReadResponse {
  readonly data?: {
    readonly data?: Record<string, unknown>;
    readonly metadata?: { readonly version?: number };
  };
}

interface KvWriteResponse {
  readonly data?: { readonly version?: number };
}

export class OpenBaoAppCredentialsAdapter
  implements OperatorAppCredentialsStorePort
{
  private readonly addr: string;
  private readonly role: string;
  private readonly readServiceAccountToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: OpenBaoAppCredentialsAdapterDeps) {
    this.addr = deps.addr.replace(/\/+$/, "");
    this.role = deps.role;
    this.readServiceAccountToken = deps.readServiceAccountToken;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async readStoredAppCredentialPair(
    env: string
  ): Promise<StoredAppCredentialPair> {
    const token = await this.login();
    const res = await this.fetchImpl(
      `${this.addr}/v1/cogni/data/${env}/${OPERATOR_BUCKET}`,
      { method: "GET", headers: { "x-vault-token": token } }
    );
    if (res.status === 404) return { configured: false, version: 0 };
    if (!res.ok) throw httpError("openbao_read_failed", res.status);
    const body = (await res.json()) as KvReadResponse;
    const data = body.data?.data ?? {};
    const version = body.data?.metadata?.version ?? 0;
    const appId =
      typeof data[APP_ID_KEY] === "string"
        ? (data[APP_ID_KEY] as string)
        : undefined;
    const material =
      typeof data[PRIVATE_KEY_KEY] === "string"
        ? (data[PRIVATE_KEY_KEY] as string)
        : undefined;
    if (appId === undefined || material === undefined) {
      return { configured: false, appId, version };
    }
    // Derive the non-secret fingerprint and let the material go out of scope —
    // nothing beyond this frame ever holds the key bytes.
    const fp = fingerprintAppPrivateKeyBase64(material);
    if (!fp.ok) {
      return { configured: true, appId, privateKeyUnparseable: true, version };
    }
    return {
      configured: true,
      appId,
      privateKeyFingerprint: fp.fingerprint,
      version,
    };
  }

  async writeAppCredentialPair(
    input: WriteAppCredentialPairInput
  ): Promise<WriteAppCredentialPairResult> {
    const token = await this.login();
    const dataPath = `cogni/data/${input.env}/${OPERATOR_BUCKET}`;
    const payload = JSON.stringify({
      data: {
        [APP_ID_KEY]: input.appId,
        [PRIVATE_KEY_KEY]: input.privateKeyBase64,
      },
      // KV-v2 check-and-set: the write succeeds only if the current version equals
      // `cas`. Version 0 = create-the-bucket; >0 = guard against concurrent writers.
      options: { cas: input.expectedVersion },
    });
    // A brand-new bucket cannot be merge-patched (there is nothing to merge into),
    // so version 0 creates via PUT; an existing bucket merge-patches, preserving
    // every sibling key at cogni/<env>/operator. Both carry the same CAS guard.
    const res =
      input.expectedVersion === 0
        ? await this.fetchImpl(`${this.addr}/v1/${dataPath}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-vault-token": token,
            },
            body: payload,
          })
        : await this.fetchImpl(`${this.addr}/v1/${dataPath}`, {
            method: "PATCH",
            headers: {
              "content-type": "application/merge-patch+json",
              "x-vault-token": token,
            },
            body: payload,
          });
    if (res.status === 400) {
      // KV-v2 reports a failed check-and-set as a 400; given we always send a
      // well-formed body, surface it as the typed CAS conflict the caller retries.
      throw httpError("openbao_cas_conflict", res.status);
    }
    if (!res.ok) throw httpError("openbao_pair_write_failed", res.status);
    const body = (await res.json()) as KvWriteResponse;
    return { version: body.data?.version ?? 0 };
  }

  /** Kubernetes-auth self-login → short-lived client token (mirrors the sibling adapter). */
  private async login(): Promise<string> {
    const jwt = await this.readServiceAccountToken();
    const res = await this.fetchImpl(`${this.addr}/v1/auth/kubernetes/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: this.role, jwt }),
    });
    if (!res.ok) throw httpError("openbao_login_failed", res.status);
    const body = (await res.json()) as { auth?: { client_token?: string } };
    const clientToken = body.auth?.client_token;
    if (!clientToken) throw httpError("openbao_login_no_token", res.status);
    return clientToken;
  }
}

function httpError(
  code: string,
  status: number
): Error & { code: string; status: number } {
  return Object.assign(new Error(`${code} (status ${status})`), {
    code,
    status,
  });
}
