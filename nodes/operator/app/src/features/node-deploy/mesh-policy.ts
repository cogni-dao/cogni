// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/mesh-policy`
 * Purpose: Derives ONE env's Headscale policy from the per-env resolver output (node id -> the substrate
 *   ports its workloads use), and decide whether a stored policy equals it (task.5429, HR 3 and 4).
 * Scope: Pure derivation and comparison. Does not perform IO or read a clock.
 * Invariants:
 *   - DERIVED_NOT_AUTHORED (HR 4): the policy is a function of the grants and the env owner only.
 *   - EXPLICIT_DENY_BASE (HR 4): every policy carries an explicit `acls` array. Headscale v0.29.7 treats a
 *     policy with no `acls` and no `grants` (including `{}`) as allow-all (hscontrol/policy/v2/policy.go,
 *     `FilterAllowAll`), so `acls: []` is the deny-all seed.
 *   - LEAST_PORTS (HR 3): one rule per node, `tag:node-<nodeId>` -> `tag:substrate:<its ports>`, TCP only.
 *     No rule names a node tag as a destination, so node to node is refused, and no port outside the
 *     service-type registry (`substrate-ports.ts`, the one port table) can be granted.
 *   - SUBSTRATE_OWNER_ALWAYS: `tagOwners` always holds `tag:substrate` owned by the env owner
 *     `cogni-mesh-<env>@`. Node tags are defined with NO owner: only a tagged pre-auth key can carry one.
 *   - STABLE_FORM: owners, rules and ports are sorted, and the serializer orders object keys, so a
 *     readback of what we wrote compares equal byte for byte.
 * Side-effects: none
 * Links: mesh-plane.ts, https://github.com/juanfont/headscale/blob/c9cf210b8bc84d13177e18b91f555788a44b47b6/docs/ref/policy.md
 * @public
 */

import { type HeadscaleUser, headscaleUser } from "@/ports";

import { SUBSTRATE_PORT_SET as ALLOWED_PORTS } from "./substrate-ports";

export const SUBSTRATE_TAG = "tag:substrate";
export const NODE_TAG_PREFIX = "tag:node-";

/** Lowercase node ids only (catalog UUIDs); a tag name must also start with a letter, which `node-` gives. */
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class MeshPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshPolicyError";
  }
}

/** `tag:node-<nodeId>`. The one tag a node's attempt keys and devices carry. */
export const nodeTag = (nodeId: string): string => {
  if (!NODE_ID.test(nodeId))
    throw new MeshPolicyError(`node id is not a valid tag name: ${nodeId}`);
  return `${NODE_TAG_PREFIX}${nodeId}`;
};

export const isNodeTag = (tag: string): boolean =>
  tag.startsWith(NODE_TAG_PREFIX) &&
  NODE_ID.test(tag.slice(NODE_TAG_PREFIX.length));

/** The env's Headscale owner object, `cogni-mesh-<env>`. */
export const meshOwner = (env: string): HeadscaleUser => {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(env))
    throw new MeshPolicyError(`env is not a valid mesh owner name: ${env}`);
  return headscaleUser(`cogni-mesh-${env}`);
};

/** The policy form of a Headscale user: the name with a trailing `@` (policy v2 `Username`). */
const ownerToken = (owner: HeadscaleUser): string => `${owner}@`;

/** One resolver output row: a node and the substrate ports its workloads use. */
export interface NodeSubstrateGrant {
  readonly nodeId: string;
  readonly ports: readonly number[];
}

export interface MeshAclRule {
  readonly action: "accept";
  readonly proto: "tcp";
  readonly src: readonly [string];
  readonly dst: readonly [string];
}

export interface MeshPolicyDocument {
  readonly tagOwners: Readonly<Record<string, readonly string[]>>;
  readonly acls: readonly MeshAclRule[];
}

/** The seed: nothing may talk to anything, and `tag:substrate` stays owned by the env owner. */
export const denyAllPolicy = (owner: HeadscaleUser): MeshPolicyDocument => ({
  tagOwners: { [SUBSTRATE_TAG]: [ownerToken(owner)] },
  acls: [],
});

/**
 * The env policy for this resolver output. A node listed twice (two workloads) gets the union of its
 * ports. A node with no ports gets its tag defined (so its key is valid) and no rule (deny).
 */
export const deriveMeshPolicy = (input: {
  readonly owner: HeadscaleUser;
  readonly grants: readonly NodeSubstrateGrant[];
}): MeshPolicyDocument => {
  const byNode = new Map<string, Set<number>>();
  for (const grant of input.grants) {
    const tag = nodeTag(grant.nodeId);
    const ports = byNode.get(tag) ?? new Set<number>();
    for (const port of grant.ports) {
      if (!ALLOWED_PORTS.has(port))
        throw new MeshPolicyError(
          `port ${port} for node ${grant.nodeId} is not a substrate port`
        );
      ports.add(port);
    }
    byNode.set(tag, ports);
  }
  const tags = [...byNode.keys()].sort();
  const tagOwners: Record<string, readonly string[]> = {
    [SUBSTRATE_TAG]: [ownerToken(input.owner)],
  };
  for (const tag of tags) tagOwners[tag] = [];
  const acls: MeshAclRule[] = [];
  for (const tag of tags) {
    const ports = [...(byNode.get(tag) ?? [])].sort((a, b) => a - b);
    if (ports.length === 0) continue;
    acls.push({
      action: "accept",
      proto: "tcp",
      src: [tag],
      dst: [`${SUBSTRATE_TAG}:${ports.join(",")}`],
    });
  }
  return { tagOwners, acls };
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
};

/** The exact text we write: object keys sorted, arrays as derived. */
export const serializeMeshPolicy = (doc: MeshPolicyDocument): string =>
  JSON.stringify(canonical(doc));

/**
 * Does the stored policy text equal the derived policy? Absent, unparsable (comments, trailing commas)
 * or any semantic or ordering difference is `false`: the caller rewrites it.
 */
export const policyMatches = (
  read: string | null | undefined,
  derived: MeshPolicyDocument
): boolean => {
  if (!read) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read);
  } catch {
    return false;
  }
  return JSON.stringify(canonical(parsed)) === serializeMeshPolicy(derived);
};

/** The node tags a policy defines: a key may be minted only for one of these. */
export const policyNodeTags = (doc: MeshPolicyDocument): Set<string> =>
  new Set(Object.keys(doc.tagOwners).filter(isNodeTag));
