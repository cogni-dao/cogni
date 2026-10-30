// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `policy`
 * Purpose: Pure bounded projection. Caller supplies current registry/provider qualification, never report body policy.
 * Scope: Additive operator-only measured-admission core. No runtime activation.
 * Invariants: Existing receipt identity; no new pool, ledger or provider authority.
 * Side-effects: None at import; explicit callers own lifecycle.
 * Links: task.5385, compute-egress-measurement-writer
 * @internal
 */
import { isIP } from "node:net";
import type {
  EgressDestination,
  EgressGrant,
  EgressObservationSnapshot,
} from "@/types/egress-admission";

export const EGRESS_LIMITS = Object.freeze({
  observationsPerReceipt: 4,
  observationsPerSnapshot: 4096,
  grantsPerDestination: 128,
  lifetimeMs: 600_000,
});
/** Reject special/private/multicast ranges; no hostname, IPv6, CIDR or caller-selected subnet. */
export function isPublicEgressIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
/** Undefined qualification means unknown dependency; [] means explicitly ineligible, not unknown. */
export function projectAdmission(
  snapshot: EgressObservationSnapshot,
  qualify: (receiptId: string) => readonly EgressDestination[] | undefined,
  custodians: readonly EgressGrant[],
  now: number
): readonly EgressGrant[] {
  if (!snapshot.complete) throw new Error("egress_incomplete_snapshot");
  if (
    snapshot.observations.length > EGRESS_LIMITS.observationsPerSnapshot ||
    custodians.length > EGRESS_LIMITS.grantsPerDestination
  )
    throw new Error("egress_observation_overflow");
  const grants = new Map<string, EgressGrant>();
  const counts = new Map<string, number>();
  function add(grant: EgressGrant) {
    if (
      !isPublicEgressIpv4(grant.ipv4) ||
      ![5432, 5435, 6379, 7233, 4000].includes(grant.publishedPort) ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(grant.destination) ||
      !Number.isSafeInteger(grant.expiresAt)
    )
      throw new Error("egress_invalid_grant");
    if (grant.expiresAt <= now) return;
    const key = JSON.stringify([
      grant.destination,
      grant.ipv4,
      grant.publishedPort,
    ]);
    const previous = grants.get(key);
    if (!previous) {
      const count = (counts.get(grant.destination) ?? 0) + 1;
      if (
        count > EGRESS_LIMITS.grantsPerDestination ||
        counts.size > 2 ||
        (!counts.has(grant.destination) && counts.size === 2)
      )
        throw new Error("egress_grant_overflow");
      counts.set(grant.destination, count);
    }
    if (!previous || previous.expiresAt < grant.expiresAt)
      grants.set(key, grant);
  }
  const receiptCounts = new Map<string, number>();
  for (const observation of snapshot.observations) {
    const count = (receiptCounts.get(observation.receiptId) ?? 0) + 1;
    if (count > EGRESS_LIMITS.observationsPerReceipt)
      throw new Error("egress_observation_capacity");
    receiptCounts.set(observation.receiptId, count);
    if (
      !Number.isSafeInteger(observation.observedAt) ||
      observation.observedAt > now ||
      observation.expiresAt !==
        observation.observedAt + EGRESS_LIMITS.lifetimeMs
    )
      throw new Error("egress_invalid_observation");
    if (observation.expiresAt <= now) continue;
    const destinations = qualify(observation.receiptId);
    if (!destinations) throw new Error("egress_unknown_dependency");
    if (destinations.length > 5) throw new Error("egress_destination_overflow");
    for (const destination of destinations)
      add({
        ...destination,
        ipv4: observation.ipv4,
        expiresAt: observation.expiresAt,
      });
  }
  for (const grant of custodians) add(grant);
  return [...grants.values()].sort(
    (a, b) =>
      a.destination.localeCompare(b.destination) ||
      a.publishedPort - b.publishedPort ||
      a.ipv4.localeCompare(b.ipv4)
  );
}
