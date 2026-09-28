// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  )
    return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return false;
  const [a = 0, b = 0] = ipv4.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/**
 * Fetch `/version` with DNS resolution performed by the actual socket lookup callback.
 * Every answer must be globally routable; redirects and IP-literal endpoints are rejected.
 */
export type SafeVersionProbeResult =
  | "version_unavailable"
  | "source_mismatch"
  | "matched";

async function safeHttpProbe(
  endpoint: string,
  path: string,
  expectedSourceSha: string | undefined,
  timeoutMs = 5_000,
  hostOverride?: string
): Promise<SafeVersionProbeResult> {
  const raw =
    endpoint.startsWith("http://") || endpoint.startsWith("https://")
      ? endpoint
      : `http://${endpoint}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "version_unavailable";
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    isIP(url.hostname) !== 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local")
  )
    return "version_unavailable";
  url.pathname = path;
  url.search = "";
  url.hash = "";

  const addresses = await new Promise<{ address: string; family: number }[]>(
    (resolve) => {
      lookup(url.hostname, { all: true, verbatim: true }, (error, result) => {
        resolve(error ? [] : result);
      });
    }
  );
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    return "version_unavailable";
  }
  const selected = addresses[0];
  if (!selected) return "version_unavailable";

  if (hostOverride) {
    // Present the PUBLIC hostname (Host header + SNI) while still connecting to the
    // already-vetted endpoint address: this exercises the provider's host-routing layer —
    // the one that decides which deployment answers the public hostname — without
    // depending on the public DNS record. The override is a hostname, never an address.
    if (
      isIP(hostOverride) !== 0 ||
      hostOverride === "localhost" ||
      hostOverride.endsWith(".local")
    )
      return "version_unavailable";
    url.hostname = hostOverride;
  }

  return new Promise<SafeVersionProbeResult>((resolve) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        timeout: timeoutMs,
        lookup: (_hostname, options, callback) => {
          // Node 22 may request every candidate for connection-family
          // autoselection. Return the already-vetted address in the callback
          // shape it requested; a scalar here raises ERR_INVALID_IP_ADDRESS.
          if (options.all) {
            callback(null, [selected]);
            return;
          }
          callback(null, selected.address, selected.family);
        },
      },
      (response) => {
        if (
          (response.statusCode ?? 500) < 200 ||
          (response.statusCode ?? 500) >= 300
        ) {
          response.resume();
          resolve("version_unavailable");
          return;
        }
        if (!expectedSourceSha) {
          response.resume();
          resolve("matched");
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length <= 16_384) body += chunk;
        });
        response.on("end", () => {
          if (body.length > 16_384) return resolve("version_unavailable");
          try {
            const parsed = JSON.parse(body) as { buildSha?: unknown };
            if (typeof parsed.buildSha !== "string") {
              resolve("version_unavailable");
              return;
            }
            resolve(
              parsed.buildSha === expectedSourceSha
                ? "matched"
                : "source_mismatch"
            );
          } catch {
            resolve("version_unavailable");
          }
        });
      }
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve("version_unavailable"));
    request.end();
  });
}

export function safeVersionProbeResult(
  endpoint: string,
  expectedSourceSha: string,
  timeoutMs = 5_000
): Promise<SafeVersionProbeResult> {
  return safeHttpProbe(endpoint, "/version", expectedSourceSha, timeoutMs);
}

export async function safeVersionProbe(
  endpoint: string,
  expectedSourceSha?: string,
  timeoutMs = 5_000
): Promise<boolean> {
  return (
    (await safeHttpProbe(
      endpoint,
      "/version",
      expectedSourceSha,
      timeoutMs
    )) === "matched"
  );
}

/**
 * `/version` proof through the provider's HOST-ROUTED path: connects to the vetted lease
 * endpoint but presents `publicHost`, so a match proves the public hostname resolves to a
 * deployment serving the exact SHA — the bare-ingress probe cannot see a stale deployment
 * still owning the hostname (bug.5237).
 */
export async function safeHostRoutedVersionProbe(
  endpoint: string,
  publicHost: string,
  expectedSourceSha?: string,
  timeoutMs = 5_000
): Promise<boolean> {
  return (
    (await safeHttpProbe(
      endpoint,
      "/version",
      expectedSourceSha,
      timeoutMs,
      publicHost
    )) === "matched"
  );
}

/** Bounded SSRF-safe HTTP 2xx application-readiness probe. */
export async function safeReadyzProbe(
  endpoint: string,
  timeoutMs = 5_000
): Promise<boolean> {
  return (
    (await safeHttpProbe(endpoint, "/readyz", undefined, timeoutMs)) ===
    "matched"
  );
}
