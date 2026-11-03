// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/edge`
 * Purpose: The blue/green edge writer — points ONE guarded public host at the active lease's
 *   provider ingress through a proxied Cloudflare CNAME, and reads the record back (task.5400).
 * Scope: Guard + orchestration over `DnsRecordsPort`. Cloudflare HTTP lives in the adapter.
 * Invariants:
 *   - HOST_GUARD: every write names a host matching the configured regex; anything else throws BEFORE
 *     any request. The zone is production. The regex is built from the image catalog
 *     (`edgeHostRegexFor`): the operator's canary plus every node whose `compute_api[<env>]` is
 *     `node-deploy`, so no per-node overlay edit is needed (CD1). The bare default is canary-only.
 *   - HOST_IS_THE_NODES_OWN: a release may only claim `hostOwnedBy(host, env, slug)`: the node's own
 *     slug (the operator's canary label for the operator) plus the env's `-test`/`-preview`/`-dev`
 *     suffix, so one node can never take another's host and operator hosts are never claimable.
 *   - NEVER_WITHDRAWN: the port has no delete; a record stays at the last proven lease through any
 *     lease failure and is only ever re-pointed (bug.5188, bug.5301).
 *   - ADOPT_BY_NAME: an existing record is updated in place whatever its type (bug.5152); a second
 *     record for the same name is refused as ambiguous.
 *   - PROXIED_REQUIRED: `proxied=true` is written AND required on readback, because provider
 *     certificates do not cover our host.
 *   - NEVER_SELF_POINT: a host is never pointed at itself (bug.5125).
 *   - READBACK_IS_THE_TRUTH: `point` returns only after a re-read shows the exact target + proxied.
 * Side-effects: IO via the injected port
 * @internal
 */

import type { DnsRecord, DnsRecordInput, DnsRecordsPort } from "@/ports";

import { hostForEnv } from "./declarations";

export const DEFAULT_EDGE_HOST_REGEX =
  /^node-deploy-canary(-[a-z]+)?\.cognidao\.org$/;

const EDGE_ZONE = "cognidao.org";
/** The operator's own workload (the canary) lives at this label, not at its slug. */
const CANARY_LABEL = "node-deploy-canary";
const OPERATOR_SLUG = "operator";

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The guard regex for these node slugs: `^(node-deploy-canary|<slug>...)(-[a-z]+)?\.cognidao\.org$`.
 * `cognidao.org`, `preview.`, `test.` and every other operator host never match (their label is not a
 * listed name).
 */
export function edgeHostRegexFor(slugs: Iterable<string>): RegExp {
  const names = [
    CANARY_LABEL,
    ...[...new Set(slugs)].filter((s) => s !== OPERATOR_SLUG).sort(),
  ].map(escapeRegex);
  return new RegExp(
    `^(${names.join("|")})(-[a-z]+)?\\.${escapeRegex(EDGE_ZONE)}$`
  );
}

/** True when `host` is exactly the host `slug` may claim in `env` (production name + env suffix). */
export function hostOwnedBy(host: string, env: string, slug: string): boolean {
  const label = slug === OPERATOR_SLUG ? CANARY_LABEL : slug;
  try {
    return host.toLowerCase() === hostForEnv(`${label}.${EDGE_ZONE}`, env);
  } catch {
    return false;
  }
}

export class EdgeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeGuardError";
  }
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");

export class EdgeRouter {
  constructor(
    private readonly dns: DnsRecordsPort,
    private readonly hostRegex: RegExp = DEFAULT_EDGE_HOST_REGEX
  ) {}

  assertHost(host: string): void {
    if (!this.hostRegex.test(host))
      throw new EdgeGuardError(
        `edge guard: refusing DNS name "${host}" (must match ${this.hostRegex})`
      );
  }

  /** The current record for `host`, or undefined. Read-only. */
  async current(host: string): Promise<DnsRecord | undefined> {
    this.assertHost(host);
    const found = await this.dns.findByName(host);
    if (found.length > 1)
      throw new EdgeGuardError(
        `edge guard: ${found.length} records named ${host}; refusing to choose`
      );
    return found[0];
  }

  /** Point `host` at `target` (a provider ingress hostname). Returns the READ-BACK record. */
  async point(host: string, target: string): Promise<DnsRecord> {
    this.assertHost(host);
    const want = norm(target);
    if (want === norm(host))
      throw new EdgeGuardError(`edge guard: ${host} must not point at itself`);
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(want))
      throw new EdgeGuardError(
        `edge guard: target "${target}" is not a hostname`
      );
    const payload: DnsRecordInput = {
      type: "CNAME",
      name: host,
      content: want,
      proxied: true,
    };
    const existing = await this.current(host);
    const written = existing
      ? await this.dns.update(existing.id, payload)
      : await this.dns.create(payload);
    const back = await this.dns.read(written.id);
    if (
      norm(back.name) !== norm(host) ||
      back.type !== "CNAME" ||
      norm(back.content) !== want ||
      back.proxied !== true
    )
      throw new EdgeGuardError(
        `edge readback mismatch for ${host}: ${JSON.stringify(back)}`
      );
    return back;
  }
}
