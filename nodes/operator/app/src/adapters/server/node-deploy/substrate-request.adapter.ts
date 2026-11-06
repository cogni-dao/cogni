// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/substrate-request.adapter`
 * Purpose: Read one tailnet's published `substrate-gw` enrollment request (task.5431, HR 11) from
 *   `https://<vm_host_for_env>/.well-known/cogni-mesh/<tailnet>/substrate-gw.json`, the per-tailnet path
 *   task.5428's VM step publishes behind the VM's DNS-only ACME site (`render-caddyfile.sh`, #3051).
 * Scope: One HTTPS GET and a strict parse. No approval decision: `MeshPlane.approveSubstrateGateway`
 *   checks age, then the registered tags and the tailnet's one `tag:substrate` device.
 * Invariants:
 *   - VERIFIED_CHANNEL: HTTPS only, the platform's public certificate and host-name verification (Node's
 *     default `fetch`), no redirect followed, bounded time and size. Anything else throws.
 *   - ABSENT_IS_NULL: only a 404 is `null`. A registered device publishes an empty `authId`; that
 *     publish is returned and approves nothing.
 *   - EXTRA_FIELDS_IGNORED: only `authId` and `publishedAt` are read. A publisher that still sends
 *     `machineKey` / `nodeKey` (#3053 until its follow-up) parses the same: no key is compared (HR 11).
 *   - NO_CREDENTIAL: the file holds public ids only; nothing here is a secret.
 * Side-effects: IO (HTTPS)
 * @internal
 */

import type {
  PublishedSubstrateRequest,
  SubstrateRequestSourcePort,
} from "@/ports";

/** `/.well-known/cogni-mesh/<tailnet>/substrate-gw.json` (one publish path per tailnet on the VM alias). */
export const substrateRequestPath = (tailnet: string): string =>
  `/.well-known/cogni-mesh/${tailnet}/substrate-gw.json`;
const MAX_BYTES = 4096;
const TIMEOUT_MS = 10_000;

const text = (v: unknown): string =>
  typeof v === "string" && v.length <= 512 ? v : "";

export class HttpsSubstrateRequestSource implements SubstrateRequestSourcePort {
  private readonly url: string;
  constructor(
    vmHost: string,
    tailnet: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!/^[a-z0-9.-]+$/u.test(vmHost))
      throw new Error(`invalid env VM host: ${vmHost}`);
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/u.test(tailnet))
      throw new Error(`invalid tailnet: ${tailnet}`);
    this.url = `https://${vmHost}${substrateRequestPath(tailnet)}`;
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
      publishedAt: Date.parse(text(raw.publishedAt)),
    };
  }
}
