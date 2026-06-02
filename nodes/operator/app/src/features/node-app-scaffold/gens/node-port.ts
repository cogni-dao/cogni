// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-app-scaffold/gens/node-port`
 * Purpose: Pure TS port of `scripts/ci/next-free-node-port.sh` (default mode) — allocate the next
 *   free k3s Service NodePort from the catalog's existing `node_port` values, so the operator can
 *   mint a `type:node` catalog entry without running bash.
 * Scope: Given the list of `node_port` integers already present in `infra/catalog/*.yaml`, return
 *   `max + 100` (preserving the ~x00 stride), or the 30000 floor when none exist.
 * Invariants: NODEPORT_STRIDE_100 — mirrors the shell's `max(node_port)+100`; CEILING_32767 — a
 *   computed port above the NodePort ceiling is a hard error (the stride is exhausted).
 * Side-effects: none — pure function, no IO, no env.
 * Links: scripts/ci/next-free-node-port.sh, docs/spec/ci-cd.md (axiom 16), task.5092
 * @public
 */

const NODE_PORT_MIN = 30000;
const NODE_PORT_MAX = 32767;
const NODE_PORT_STRIDE = 100;

/**
 * Allocate the next free NodePort: `max(catalogNodePorts) + 100`, or `30000` when the catalog has
 * no `type:node` entries yet. Throws when the result overflows the NodePort ceiling (32767).
 */
export function nextFreeNodePort(catalogNodePorts: readonly number[]): number {
  const max = catalogNodePorts.reduce(
    (acc, port) => (port > acc ? port : acc),
    Number.NEGATIVE_INFINITY
  );
  const next =
    max === Number.NEGATIVE_INFINITY ? NODE_PORT_MIN : max + NODE_PORT_STRIDE;
  if (next > NODE_PORT_MAX) {
    throw new Error(
      `nextFreeNodePort: next port ${next} exceeds the NodePort ceiling ${NODE_PORT_MAX}; ` +
        "the ~x00 stride is exhausted — compact existing node_port values or widen the range."
    );
  }
  return next;
}
