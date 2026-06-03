/**
 * Module: `@scripts/lib/print-pod-keys`
 * Purpose: Emit the set of secret KEY NAMES that fan out to a node's pod,
 *   derived ONLY from the secrets catalog (spec.secrets-management Invariant 14
 *   CATALOG_IS_THE_ONE_READER). This is the single reader the bash provisioning
 *   side consumes — it retires the hand-maintained `NODE_BASELINE_KEYS` array in
 *   reconcile-secrets.sh so a catalog entry (e.g. DOLTHUB_*) can never again be
 *   declared-but-dormant.
 * Invariants: a key is pod-eligible iff it is tier A1/A2 AND resolves to an
 *   OpenBao pod path (`openBaoPathFor` non-null: has `service` or `appliesTo`).
 *   B/D/E (CI/Compose/repo) and `_system` (G-derived) keys never reach a pod via
 *   envFrom and are excluded. Per-node membership gating stays in bash
 *   (`_node_gets_key`); this emitter produces the node-agnostic universe.
 * Usage: `tsx scripts/lib/print-pod-keys.ts [--repo-root <dir>]`
 *   → prints one pod-eligible key name per line, sorted, to stdout.
 */
import { loadSecretsCatalog, openBaoPathFor } from "./secrets-catalog-loader";

function repoRootFromArgv(argv: string[]): string {
  const i = argv.indexOf("--repo-root");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.cwd();
}

export function podKeyUniverse(repoRoot: string): string[] {
  const { routing } = loadSecretsCatalog({ repoRoot });
  const keys: string[] = [];
  for (const [name, r] of Object.entries(routing)) {
    if (r.tier !== "A1" && r.tier !== "A2") continue;
    // `node`/`env` are placeholders — pod-eligibility (non-null path) does not
    // depend on which node; the path SHAPE does, but presence does not.
    if (openBaoPathFor(r, name, "__probe__", "__probe__") === null) continue;
    keys.push(name);
  }
  return keys.sort();
}

function main(): void {
  const repoRoot = repoRootFromArgv(process.argv.slice(2));
  for (const k of podKeyUniverse(repoRoot)) process.stdout.write(`${k}\n`);
}

// Run only when invoked directly (allows import in unit tests).
if (process.argv[1] && process.argv[1].endsWith("print-pod-keys.ts")) {
  main();
}
