// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/substrate-request.adapter`
 * Purpose: Read the env VM's published `substrate-gw` enrollment request (task.5431, HR 11) from
 *   `https://<vm_host_for_env>/.well-known/cogni-mesh/substrate-gw.json`, the path task.5428's VM step
 *   publishes behind the VM's DNS-only ACME site (`render-caddyfile.sh`, `substrate-gw.sh`).
 * Scope: One HTTPS GET and a strict parse. No approval decision: `MeshPlane.approveSubstrateGateway`
 *   checks age, tags and keys.
 * Invariants:
 *   - VERIFIED_CHANNEL: HTTPS only, the platform's public certificate and host-name verification (Node's
 *     default `fetch`), no redirect followed, bounded time and size. Anything else throws.
 *   - ABSENT_IS_NULL: only a 404 is `null`. A registered device publishes an empty `authId` with its
 *     machine and node keys; that publish is returned, because the node-key check (stage 2 of HR 11)
 *     reads it after approval.
 *   - NO_CREDENTIAL: the file holds public ids only; nothing here is a secret.
 * Side-effects: IO (HTTPS)
 * @internal
 */

import type {
  PublishedSubstrateRequest,
  SubstrateRequestSourcePort,
} from "@/ports";

export const SUBSTRATE_REQUEST_PATH =
  "/.well-known/cogni-mesh/substrate-gw.json";
const MAX_BYTES = 4096;
const TIMEOUT_MS = 10_000;

const text = (v: unknown): string =>
  typeof v === "string" && v.length <= 512 ? v : "";

export class HttpsSubstrateRequestSource implements SubstrateRequestSourcePort {
  private readonly url: string;
  constructor(
    vmHost: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!/^[a-z0-9.-]+$/u.test(vmHost))
      throw new Error(`invalid env VM host: ${vmHost}`);
    this.url = `https://${vmHost}${SUBSTRATE_REQUEST_PATH}`;
  }

  async read(): Promise<PublishedSubstrateRequest | null> {
    const res = await this.fetchImpl(this.url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`substrate request read: HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES)
      throw new Error("substrate request read: body too large");
    const raw = JSON.parse(body) as Record<string, unknown>;
    return {
      authId: text(raw.authId),
      machineKey: text(raw.machineKey),
      nodeKey: text(raw.nodeKey),
      publishedAt: Date.parse(text(raw.publishedAt)),
    };
  }
}
