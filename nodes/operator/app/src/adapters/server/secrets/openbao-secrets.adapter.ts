// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/secrets/openbao-secrets`
 * Purpose: Write a node-owned secret value to OpenBao via the operator pod's OWN
 *   in-cluster identity — Kubernetes-auth self-login over ClusterIP, then KV-v2
 *   put (new node path) / patch (existing). Realizes the in-cluster north star
 *   named in scripts/ci/secret-materialize.sh — zero SSH, zero `kubectl create token`.
 * Scope: One write per call. No catalog read (gate 2 is upstream), no node scope
 *   in the token (that is the app's job — see route + design §Security boundary).
 * Invariants:
 *   - SELF_LOGIN: the pod authenticates with its projected SA token; no caller creds.
 *   - NO_SECRETS_IN_CONTEXT: the writer token + value are never logged; value goes
 *     in the JSON body only, never a query string or argv.
 *   - PATCH_PRESERVES_SIBLINGS: existing node path → merge-patch, never clobber.
 * Side-effects: IO (reads the projected SA token file; OpenBao HTTP API).
 * Links: docs/design/node-self-serve-secrets.md, scripts/secrets/set-secret.sh
 *   (the put-vs-patch gate this mirrors), src/ports/operator-secrets-plane.port.ts
 * @public
 */

import type {
  OperatorSecretsPlanePort,
  WriteNodeSecretInput,
  WriteNodeSecretResult,
} from "@/ports";

export interface OpenBaoSecretsAdapterDeps {
  /** OpenBao ClusterIP base, e.g. `http://openbao.openbao.svc:8200`. */
  readonly addr: string;
  /** k8s-auth role bound to the operator-secrets-writer SA, e.g. `candidate-a-node-secrets-writer`. */
  readonly role: string;
  /** Reads the pod's projected SA token (`audience: cogni-openbao`). Injected for testability. */
  readonly readServiceAccountToken: () => Promise<string>;
  /** Defaults to global `fetch`; injected in unit tests. */
  readonly fetchImpl?: typeof fetch;
}

interface KvWriteResponse {
  readonly data?: { readonly version?: number };
}

export class OpenBaoSecretsAdapter implements OperatorSecretsPlanePort {
  private readonly addr: string;
  private readonly role: string;
  private readonly readServiceAccountToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: OpenBaoSecretsAdapterDeps) {
    this.addr = deps.addr.replace(/\/+$/, "");
    this.role = deps.role;
    this.readServiceAccountToken = deps.readServiceAccountToken;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async writeSecret(
    input: WriteNodeSecretInput
  ): Promise<WriteNodeSecretResult> {
    const path = `cogni/${input.env}/${input.nodeSlug}/${input.key}`;
    const token = await this.login();
    // KV v2 data endpoint requires the `data/` infix: <mount>/data/<path>.
    // (metadata uses <mount>/metadata/<path>; the put/patch policy grants
    // `cogni/data/<env>/*`.) The returned `path` above stays logical for display.
    const dataPath = `cogni/data/${input.env}/${input.nodeSlug}`;
    const exists = await this.nodePathExists(token, input.env, input.nodeSlug);
    const version = exists
      ? await this.patch(token, dataPath, input.key, input.value)
      : await this.put(token, dataPath, input.key, input.value);
    return { written: true, version, path };
  }

  /** Kubernetes-auth self-login → short-lived client token. */
  private async login(): Promise<string> {
    const jwt = await this.readServiceAccountToken();
    const res = await this.fetchImpl(`${this.addr}/v1/auth/kubernetes/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: this.role, jwt }),
    });
    if (!res.ok) {
      throw httpError("openbao_login_failed", res.status);
    }
    const body = (await res.json()) as { auth?: { client_token?: string } };
    const clientToken = body.auth?.client_token;
    if (!clientToken) {
      throw httpError("openbao_login_no_token", res.status);
    }
    return clientToken;
  }

  /** Put-vs-patch gate (mirrors set-secret.sh): metadata 200 → patch, 404 → put. */
  private async nodePathExists(
    token: string,
    env: string,
    nodeSlug: string
  ): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.addr}/v1/cogni/metadata/${env}/${nodeSlug}`,
      { method: "GET", headers: { "x-vault-token": token } }
    );
    if (res.status === 404) return false;
    if (!res.ok) throw httpError("openbao_metadata_failed", res.status);
    return true;
  }

  private async put(
    token: string,
    dataPath: string,
    key: string,
    value: string
  ): Promise<number> {
    const res = await this.fetchImpl(`${this.addr}/v1/${dataPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vault-token": token },
      body: JSON.stringify({ data: { [key]: value } }),
    });
    return readVersion(res, "openbao_put_failed");
  }

  private async patch(
    token: string,
    dataPath: string,
    key: string,
    value: string
  ): Promise<number> {
    const res = await this.fetchImpl(`${this.addr}/v1/${dataPath}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "x-vault-token": token,
      },
      body: JSON.stringify({ data: { [key]: value } }),
    });
    return readVersion(res, "openbao_patch_failed");
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

async function readVersion(res: Response, failCode: string): Promise<number> {
  if (!res.ok) throw httpError(failCode, res.status);
  const body = (await res.json()) as KvWriteResponse;
  return body.data?.version ?? 0;
}
