// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/caddyfile`
 * Purpose: Pin `insertCaddyBlock` / `removeCaddyBlock` to a byte-exact round-trip so the operator's
 *   add/decommission emit can't skew against `bash scripts/ci/render-caddyfile.sh` (story.5020).
 * Scope: Pure unit tests — the inverse property (remove ∘ insert == identity) proves the decommission
 *   path restores the file byte-for-byte without hand-writing block internals.
 * Invariants: CATALOG_IS_SSOT — removing a node's block matches the renderer once it leaves the catalog;
 *   the primary (operator) block is never touched; exactly one blank line stays between adjacent blocks.
 * Side-effects: none
 * Links: src/shared/node-app-scaffold/gens/caddyfile, scripts/ci/render-caddyfile.sh
 * @public
 */

import { describe, expect, it } from "vitest";

import { insertCaddyBlock, removeCaddyBlock } from "./caddyfile";

// Minimal seed: a global block + the primary (operator) site block. Non-primary blocks are built by
// insertCaddyBlock so the fixtures stay byte-exact to the real emitter.
const SEED = `{
\temail ops@example.com
}

# ── operator (primary domain) → k3s NodePort 30100 ──────────────────────────────────
operator.localhost {
  reverse_proxy host.docker.internal:30100
}
`;

describe("removeCaddyBlock", () => {
  it("is the exact inverse of insertCaddyBlock for the only non-primary node", () => {
    const withZebra = insertCaddyBlock(SEED, "zebra", 32000);
    expect(removeCaddyBlock(withZebra, "zebra")).toBe(SEED);
  });

  it("removes a middle non-primary block, leaving neighbors + primary intact", () => {
    // Build a file with three non-primary nodes in sorted order.
    const withAlpha = insertCaddyBlock(SEED, "alpha", 31000);
    const withAlphaMid = insertCaddyBlock(withAlpha, "mid", 31500);
    const all = insertCaddyBlock(withAlphaMid, "zebra", 32000);
    // Dropping the middle one must equal the file built without it.
    expect(removeCaddyBlock(all, "mid")).toBe(withAlpha2(SEED));
  });

  it("is idempotent when the node has no block", () => {
    const withZebra = insertCaddyBlock(SEED, "zebra", 32000);
    expect(removeCaddyBlock(withZebra, "absent")).toBe(withZebra);
  });

  it("never removes the primary (operator) block", () => {
    expect(removeCaddyBlock(SEED, "operator")).toBe(SEED);
  });
});

// Helper: a file with just alpha + zebra (no mid), built via insert so it's byte-exact.
function withAlpha2(seed: string): string {
  return insertCaddyBlock(
    insertCaddyBlock(seed, "alpha", 31000),
    "zebra",
    32000
  );
}
