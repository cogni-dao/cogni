// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/domain-expiry.reader`
 * Purpose: Domain renewal — days until the registry expiration event, graded by the shared expiry policy.
 * Scope: One keyless RDAP GET (https://rdap.org/domain/<name>, redirects followed by the platform fetch).
 * Invariants: READERS_NEVER_THROW. No balance or burn: an expiry plane only has days left. Failure ⇒ UNKNOWN "registry read failed".
 * Side-effects: IO (HTTPS GET via injected fetch)
 * Links: https://cognidao.org/knowledge/money-plane-registry, https://cognidao.org/work/items/task.5347
 * @public
 */
import {
  type FetchLike,
  gradeExpiry,
  type MoneyPlaneRow,
  type PlaneReader,
  unknownRow,
} from "@cogni/money-plane";

export const RDAP_URL = "https://rdap.org/domain";

interface RdapEvent {
  eventAction?: unknown;
  eventDate?: unknown;
}

/** Days from `now` to the RDAP expiration event; null when absent or unparseable. */
export function expiryDays(events: unknown, now: Date): number | null {
  if (!Array.isArray(events)) return null;
  const event = (events as RdapEvent[]).find(
    (e) => e.eventAction === "expiration"
  );
  const expiry = Date.parse(String(event?.eventDate ?? ""));
  if (!Number.isFinite(expiry)) return null;
  return (expiry - now.getTime()) / 86_400_000;
}

export interface DomainExpiryReaderOptions {
  domain: string;
  fetch: FetchLike;
  rdapUrl?: string;
  now?: () => Date;
}

export function domainExpiryReader(
  options: DomainExpiryReaderOptions
): PlaneReader {
  const plane = `domain:${options.domain}`;
  const label = `Domain ${options.domain}`;
  const now = options.now ?? (() => new Date());
  const rail = {
    kind: "card-manual" as const,
    status: "planned" as const,
    guide: "registrar",
  };
  const unknown = (detail: string): MoneyPlaneRow => ({
    ...unknownRow({
      plane,
      label,
      kind: "expiry",
      reasonCode: "unreadable",
      observedAt: now().toISOString(),
      detail,
    }),
    rail,
  });
  return {
    plane,
    label,
    kind: "expiry",
    async read(signal): Promise<MoneyPlaneRow> {
      try {
        const res = await options.fetch(
          `${options.rdapUrl ?? RDAP_URL}/${encodeURIComponent(options.domain)}`,
          { headers: { Accept: "application/rdap+json" }, signal }
        );
        if (!res.ok) return unknown("registry read failed");
        const body = (await res.json()) as { events?: unknown } | null;
        const at = now();
        const days = expiryDays(body?.events, at);
        if (days === null) return unknown("no expiration event in record");
        const observedAt = at.toISOString();
        const expiresOn = new Date(at.getTime() + days * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return {
          plane,
          label,
          kind: "expiry",
          balance: null,
          currency: null,
          burnPerDay: null,
          runwayDays: Math.max(days, 0),
          grade: gradeExpiry(days),
          observedAt,
          source: "RDAP registry record",
          sourceObservedAt: observedAt,
          freshness: "current",
          payer: "Operator",
          rail,
          detail: `expires ${expiresOn}`,
        };
      } catch {
        return unknown("registry read failed");
      }
    },
  };
}
