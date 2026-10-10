// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/secrets/openbao-secrets`
 * Purpose: Write a node-owned secret value to OpenBao via the operator pod's OWN
 *   in-cluster identity — Kubernetes-auth self-login over ClusterIP, then KV-v2
 *   put (new node path) / patch (existing). Realizes the in-cluster north star
 *   named in scripts/ci/secret-materialize.sh — zero SSH, zero `kubectl create token`.
 * Scope: One write or constant-time verification per call. The bucket is the node's namespace,
 *   or a platform-service bucket the route already authorized. No catalog read (gate 2 is
 *   upstream), no node scope in the OpenBao token (the app derives it from the workload token).
 * Invariants:
 *   - SELF_LOGIN: the pod authenticates with its projected SA token; no caller creds.
 *   - NO_SECRETS_IN_CONTEXT: the writer token + value are never logged; value goes
 *     in the JSON body only, never a query string or argv.
 *   - PATCH_PRESERVES_SIBLINGS: existing node path → merge-patch, never clobber.
 *   - ROTATION_OVERLAP_IS_BOUNDED: verification may accept only KV version N-1 and
 *     only while current version N is within the configured rollout window.
 * Side-effects: IO (reads the projected SA token file; OpenBao HTTP API).
 * Links: docs/design/node-self-serve-secrets.md, scripts/secrets/set-secret.sh
 *   (the put-vs-patch gate this mirrors), src/ports/operator-secrets-plane.port.ts
 * @public
 */

import { timingSafeEqual } from "node:crypto";

import type {
  OperatorSecretsPlanePort,
  VerifyNodeSecretInput,
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
  /** Bounded previous-version acceptance during an ESO rollout. Defaults to ten minutes. */
  readonly credentialOverlapMs?: number;
  /** Clock injected for deterministic overlap tests. */
  readonly now?: () => Date;
}

interface KvWriteResponse {
  readonly data?: { readonly version?: number };
}

interface KvReadResponse {
  readonly data?: {
    readonly data?: Readonly<Record<string, unknown>>;
    readonly metadata?: {
      readonly version?: number;
      readonly created_time?: string;
    };
  };
}

export class OpenBaoSecretsAdapter implements OperatorSecretsPlanePort {
  private readonly addr: string;
  private readonly role: string;
  private readonly readServiceAccountToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly credentialOverlapMs: number;
  private readonly now: () => Date;

  constructor(deps: OpenBaoSecretsAdapterDeps) {
    this.addr = deps.addr.replace(/\/+$/, "");
    this.role = deps.role;
    this.readServiceAccountToken = deps.readServiceAccountToken;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.credentialOverlapMs = deps.credentialOverlapMs ?? 10 * 60_000;
    this.now = deps.now ?? (() => new Date());
  }

  async writeSecret(
    input: WriteNodeSecretInput
  ): Promise<WriteNodeSecretResult> {
    // The bucket is the node's own namespace unless the route resolved (and authorized)
    // a platform-service bucket. Absent `service` → the pre-existing path, unchanged.
    const bucket = input.service ?? input.nodeSlug;
    const path = `cogni/${input.env}/${bucket}/${input.key}`;
    const token = await this.login();
    // KV v2 data endpoint requires the `data/` infix: <mount>/data/<path>.
    // (metadata uses <mount>/metadata/<path>; the put/patch policy grants
    // `cogni/data/<env>/*`.) The returned `path` above stays logical for display.
    const dataPath = `cogni/data/${input.env}/${bucket}`;
    const exists = await this.bucketExists(token, input.env, bucket);
    const version = exists
      ? await this.patch(token, dataPath, input.key, input.value)
      : await this.put(token, dataPath, input.key, input.value);
    return { written: true, version, path };
  }

  async verifySecret(input: VerifyNodeSecretInput): Promise<boolean> {
    const token = await this.login();
    const current = await this.readSecretVersion(token, input);
    if (!current) return false;
    if (secretMatches(input.presentedValue, current.data?.[input.key])) {
      return true;
    }

    // Rotation continuity: ESO may still project the immediately previous value
    // while OpenBao already exposes the new current version. Accept exactly N-1,
    // and only for a bounded interval stamped by OpenBao's current version.
    const version = current.metadata?.version;
    const createdAt = Date.parse(current.metadata?.created_time ?? "");
    const ageMs = this.now().getTime() - createdAt;
    const withinOverlap =
      Number.isFinite(createdAt) &&
      ageMs >= 0 &&
      ageMs <= this.credentialOverlapMs;
    if (!version || version <= 1 || !withinOverlap) return false;

    const previous = await this.readSecretVersion(token, input, version - 1);
    return secretMatches(input.presentedValue, previous?.data?.[input.key]);
  }

  private async readSecretVersion(
    token: string,
    input: VerifyNodeSecretInput,
    version?: number
  ): Promise<KvReadResponse["data"] | undefined> {
    const query = version === undefined ? "" : `?version=${version}`;
    const res = await this.fetchImpl(
      `${this.addr}/v1/cogni/data/${input.env}/${input.nodeSlug}${query}`,
      { method: "GET", headers: { "x-vault-token": token } }
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw httpError("openbao_read_failed", res.status);
    return ((await res.json()) as KvReadResponse).data;
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
  private async bucketExists(
    token: string,
    env: string,
    bucket: string
  ): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.addr}/v1/cogni/metadata/${env}/${bucket}`,
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

function secretMatches(presented: string, expected: unknown): boolean {
  if (typeof expected !== "string") return false;
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    presentedBytes.length === expectedBytes.length &&
    timingSafeEqual(presentedBytes, expectedBytes)
  );
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
