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
 *   - HOST_IS_THE_NODES_OWN: a release may only claim `hostOwnedBy(host, env, slug, workload)`: the node's own
 *     slug (the operator's canary label for the operator), or `<slug>-<workload>` for a sibling workload of
 *     that node, plus the env's `-test`/`-preview`/`-dev` suffix, so one node can never take another's host
 *     and operator hosts are never claimable.
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

import { HOST_ENVS, hostForEnv } from "./declarations";

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
    `^(${names.join("|")})(-[a-z]+(-[a-z]+)?)?\\.${escapeRegex(EDGE_ZONE)}$`
  );
}

/**
 * True when `host` is a host `slug` may claim in `env`: its own production name plus the env suffix, or,
 * for a sibling `workload` of the node (task.5272, e.g. red's `sandbox`), `<slug>-<workload>` plus the same
 * suffix (`red-sandbox`, `red-sandbox-test`, `red-sandbox-preview`). The operator owns only its canary
 * label; a workload never widens it.
 */
export function hostOwnedBy(
  host: string,
  env: string,
  slug: string,
  workload?: string
): boolean {
  const label = slug === OPERATOR_SLUG ? CANARY_LABEL : slug;
  const labels =
    workload && slug !== OPERATOR_SLUG && workload !== slug
      ? [label, `${label}-${workload}`]
      : [label];
  try {
    return labels.some(
      (l) => host.toLowerCase() === hostForEnv(`${l}.${EDGE_ZONE}`, env)
    );
  } catch {
    return false;
  }
}

/**
 * WORKER_HOST_IS_UNAMBIGUOUS (task.5272): why a sibling worker `<slug>-<workload>[-env]` host may NOT be
 * claimed, or undefined when it may. A worker host is checked at the pre-create step, after
 * `hostOwnedBy(.., workload)`; it must not collide with any host another catalog node (or this node's
 * own app in another environment) could claim:
 *   - the workload name is one plain label (`[a-z][a-z0-9]*`, no hyphen) and is not an environment word
 *     (`test`, `preview`, `dev`), so `poly` + `test` can never reach `poly-test` and `a` + `b-c` can
 *     never meet node `a-b` + `c`;
 *   - no OTHER catalog slug owns the host in any environment (`red` + `sandbox` vs node `red-sandbox`);
 *   - this node's own host in another environment is not the host.
 */
export function workerHostRefusal(input: {
  readonly host: string;
  readonly env: string;
  readonly slug: string;
  readonly workload: string;
  readonly catalogSlugs: readonly string[];
}): string | undefined {
  const { host, env, slug, workload } = input;
  if (!/^[a-z][a-z0-9]*$/.test(workload))
    return `worker name "${workload}" must be one plain label (letters and digits)`;
  if (["test", "preview", "dev"].includes(workload))
    return `worker name "${workload}" is an environment word`;
  for (const other of input.catalogSlugs) {
    if (other === slug) continue;
    for (const e of HOST_ENVS)
      if (hostOwnedBy(host, e, other))
        return `${host} is node ${other}'s host in ${e}`;
  }
  for (const e of HOST_ENVS)
    if (e !== env && hostOwnedBy(host, e, slug))
      return `${host} is this node's own host in ${e}`;
  return undefined;
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
