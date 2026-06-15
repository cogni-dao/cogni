// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/print-pod-keys`
 * Purpose: Emit the secret KEY NAMES that fan out to a node's pod, derived ONLY from the secrets catalog (spec.secrets-management Invariant 14 CATALOG_IS_THE_ONE_READER) — the single reader the bash provisioning side consumes to retire the hand-maintained NODE_BASELINE_KEYS array.
 * Scope: Pure read + filter over the loaded catalog routing. Prints to stdout; does NOT shell out, write files, or touch OpenBao/git state.
 * Invariants: pod-consumed iff `pod ∈ consumedBy`, else an A1/A2 entry with an OpenBao pod path.
 * Side-effects: IO (stdout write; reads catalog YAML transitively via loadSecretsCatalog)
 * Links: docs/spec/secrets-management.md, docs/design/secrets-catalog-per-node.md
 *
 * A key is pod-consumed iff `pod ∈ consumedBy` (explicit), else an A1/A2 entry
 * that resolves to an OpenBao pod path. Per-node membership gating stays in bash
 * (`_node_gets_key`); this emitter produces the node-agnostic universe.
 * Usage: `tsx scripts/lib/print-pod-keys.ts [--repo-root <dir>]` → one key/line.
 */
import {
  loadSecretsCatalog,
  openBaoPathFor,
  type SecretRouting,
} from "./secrets-catalog-loader";

function repoRootFromArgv(argv: string[]): string {
  const i = argv.indexOf("--repo-root");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.cwd();
}

/**
 * Is this key consumed by node-app pods? Explicit `consumedBy` wins (the
 * authoritative axis — a B-tier key the pod also reads, e.g. OPENROUTER_API_KEY,
 * declares `consumedBy: [compose, pod]`). Absent → default from tier+path: an
 * A1/A2 entry that resolves to an OpenBao pod path is pod-consumed; everything
 * else (B/D/E/G with no path) is not. `node`/`env` are placeholders — path
 * PRESENCE is node-agnostic.
 */
export function isPodConsumed(name: string, r: SecretRouting): boolean {
  if (r.consumedBy !== undefined) return r.consumedBy.includes("pod");
  if (r.tier !== "A1" && r.tier !== "A2") return false;
  return openBaoPathFor(r, name, "__probe__", "__probe__") !== null;
}

export function podKeyUniverse(repoRoot: string): string[] {
  const { routing } = loadSecretsCatalog({ repoRoot });
  return Object.entries(routing)
    .filter(([name, r]) => isPodConsumed(name, r))
    .map(([name]) => name)
    .sort();
}

function main(): void {
  const repoRoot = repoRootFromArgv(process.argv.slice(2));
  for (const k of podKeyUniverse(repoRoot)) process.stdout.write(`${k}\n`);
}

// Run only when invoked directly (allows import in unit tests).
if (process.argv[1]?.endsWith("print-pod-keys.ts")) {
  main();
}
