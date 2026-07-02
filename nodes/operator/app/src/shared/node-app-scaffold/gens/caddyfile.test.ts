// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/caddyfile`
 * Purpose: Pin `insertCaddyBlock` to a byte-exact emit so the operator's node-formation add can't skew
 *   against `bash scripts/ci/render-caddyfile.sh` (story.5020).
 * Scope: Pure unit tests — sorted splice, idempotent-reject, and the untouched primary block.
 * Invariants: CATALOG_IS_SSOT — the inserted block matches the renderer once the node joins the catalog;
 *   the primary (operator) block is never touched; exactly one blank line stays between adjacent blocks.
 * Side-effects: none
 * Links: src/shared/node-app-scaffold/gens/caddyfile, scripts/ci/render-caddyfile.sh
 * @public
 */

import { describe, expect, it } from "vitest";

import { insertCaddyBlock } from "./caddyfile";

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

describe("insertCaddyBlock", () => {
  it("inserts a non-primary block with its own leading blank line", () => {
    const out = insertCaddyBlock(SEED, "zebra", 32000);
    expect(out).toContain(
      "# ── zebra node → k3s NodePort 32000 ──────────────────────────────────"
    );
    // The block carries exactly one blank line before its comment.
    expect(out).toContain("}\n\n# ── zebra node");
    // The primary (operator) block is left intact.
    expect(out).toContain(
      "# ── operator (primary domain) → k3s NodePort 30100"
    );
  });

  it("splices non-primary nodes into slug-sorted order", () => {
    const withAlpha = insertCaddyBlock(SEED, "alpha", 31000);
    const all = insertCaddyBlock(withAlpha, "zebra", 32000);
    expect(all.indexOf("# ── alpha node")).toBeLessThan(
      all.indexOf("# ── zebra node")
    );
    // `mid` sorts between alpha and zebra.
    const withMid = insertCaddyBlock(all, "mid", 31500);
    expect(withMid.indexOf("# ── alpha node")).toBeLessThan(
      withMid.indexOf("# ── mid node")
    );
    expect(withMid.indexOf("# ── mid node")).toBeLessThan(
      withMid.indexOf("# ── zebra node")
    );
  });

  it("rejects a node whose block already exists", () => {
    const withZebra = insertCaddyBlock(SEED, "zebra", 32000);
    expect(() => insertCaddyBlock(withZebra, "zebra", 32000)).toThrow(
      /already contains/
    );
  });
});
