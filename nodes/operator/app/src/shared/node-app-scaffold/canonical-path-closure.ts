// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/canonical-path-closure`
 * Purpose: Turn the DECLARED Tier-1 roots (canonical workflows + contract entrypoints) into the
 *   TRANSITIVE set a fork actually needs to build them. A hand-maintained Tier-1 list silently ships
 *   half a contract: node-template's `pr-build.yml` gained `oras push` + `scripts/ci/*.mjs`, and
 *   `packages/repo-spec/src/index.ts` gained `export … from "./artifact-bundle.js"`, but neither the
 *   scripts nor the module were listed — so every fork's sync PR delivered a workflow that invokes
 *   missing scripts and a barrel that re-exports a missing module (task.5078).
 * Scope: Pure derivation over file CONTENT + one async driver that walks it with an injected reader.
 *   No GitHub, no fs — the adapter supplies `read`. Deliberately BOUNDED (see CLOSURE_IS_BOUNDED).
 * Invariants:
 *   - TIER1_IS_CLOSED: whatever a canonical workflow invokes, and whatever a canonical contract module
 *     re-exports, ships in the SAME sync. Adding a script or a module to node-template needs no operator
 *     change — the closure finds it. (spec.repo-sync-contract § Three-Tier Fork Sync.)
 *   - CLOSURE_IS_BOUNDED: derivation expands only (a) `scripts/**` referenced by a canonical workflow,
 *     (b) relative module edges INSIDE one `packages/<pkg>/src/**` contract package, (c) a contract
 *     package's build manifest + tsup entries, (d) `packages/<pkg>/dist/*.js` → `src/*.ts` for the
 *     build-output imports CI scripts use. `app/**` is NEVER expanded — the app is Tier-2 substrate
 *     delivered by the upstream merge, and following its `@/…` graph would drag the whole tree into
 *     the force-overwrite tier.
 *   - ROOTS_FAIL_CLOSED: a declared root missing at the source ref is an error (as before). A DERIVED
 *     path is `required` when it came from a real module edge (a broken import means the SOURCE is
 *     broken) and `optional` when it came from a textual/heuristic reference (workflow prose, an
 *     absent `tsconfig.json`), so heuristics can never fail a sync.
 * Side-effects: none (the injected `read` does IO)
 * Links: src/adapters/server/vcs/github-repo-write.ts,
 *   src/app/_facades/deploy/canonical-fork-sync.server.ts, docs/spec/repo-sync-contract.md
 * @public
 */

/** Whether a derived path missing at the source ref is an error or is simply skipped. */
export type CanonicalPathRequirement = "required" | "optional";

/** One edge of the Tier-1 closure: a path plus how hard we insist the source has it. */
export interface CanonicalPathReference {
  readonly path: string;
  readonly requirement: CanonicalPathRequirement;
}

/** A resolved Tier-1 file: repo-relative path + its content at the source ref. */
export interface CanonicalClosureFile {
  readonly path: string;
  readonly content: string;
}

const WORKFLOW_PATH_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const CONTRACT_PACKAGE_SRC_RE =
  /^(packages\/[^/]+)\/src\/.+\.(?:ts|tsx|mts|cts)$/;
const TSUP_CONFIG_RE = /^(packages\/[^/]+)\/tsup\.config\.ts$/;
const SCRIPT_MODULE_RE = /^scripts\/.+\.(?:mjs|cjs|js|ts)$/;

/** Repo-relative `scripts/...` reference anywhere in a workflow body (`node scripts/ci/x.mjs`, `"$GITHUB_WORKSPACE/scripts/ci/x.mjs"`). */
const WORKFLOW_SCRIPT_REF_RE =
  /\bscripts\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:mjs|cjs|js|ts|sh)\b/g;

/** ESM/CJS module specifiers: `from "x"`, `import "x"`, `import("x")`, `require("x")`. */
const MODULE_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

/** `entry: ["src/index.ts", "src/testing.ts"]` in a tsup config — the package's real build entrypoints. */
const TSUP_ENTRY_RE =
  /["'](src\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:ts|tsx|mts|cts))["']/g;

/** Files a contract package needs to compile at all, beyond its sources. */
const PACKAGE_BUILD_MANIFEST = [
  "package.json",
  "tsconfig.json",
  "tsup.config.ts",
] as const;

/**
 * Resolve a `./`-or-`../` specifier against the importing file's directory. Returns null when the
 * specifier is bare (a package name — `zod`, `@cogni/repo-spec`) or escapes the repo root.
 */
function resolveRelative(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const slash = fromPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : fromPath.slice(0, slash);
  const out: string[] = dir ? dir.split("/") : [];
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

/**
 * Map an import TARGET to the path that actually lives in git. TypeScript ESM imports its own siblings
 * as `./x.js`; CI scripts import the package's BUILD OUTPUT (`../../packages/repo-spec/dist/index.js`).
 * Neither is a tracked file — the tracked file is the `src/*.ts` that produces it.
 */
function toTrackedSourcePath(resolved: string): string {
  const distMatch = /^(packages\/[^/]+)\/dist\/(.+)\.(?:js|mjs|cjs)$/.exec(
    resolved
  );
  if (distMatch) return `${distMatch[1]}/src/${distMatch[2]}.ts`;
  if (/^packages\/[^/]+\/src\/.+\.js$/.test(resolved)) {
    return resolved.replace(/\.js$/, ".ts");
  }
  return resolved;
}

/**
 * The Tier-1 edges out of one file. Pure: same (path, content) ⇒ same result.
 *
 * Bounded by design (CLOSURE_IS_BOUNDED) — only canonical workflows, `scripts/**`, and
 * `packages/<pkg>/**` contract packages expand. Anything else (notably `app/**`) yields nothing.
 */
export function deriveReferencedPaths(
  path: string,
  content: string
): readonly CanonicalPathReference[] {
  const refs: CanonicalPathReference[] = [];
  const seen = new Set<string>();
  const add = (
    candidate: string | null | undefined,
    requirement: CanonicalPathRequirement
  ): void => {
    if (!candidate || candidate === path || seen.has(candidate)) return;
    seen.add(candidate);
    refs.push({ path: candidate, requirement });
  };

  // (a) A canonical workflow pulls in every repo script it invokes. Textual ⇒ `optional`: a workflow
  //     may mention a path in prose, and a heuristic must never fail a required sync.
  if (WORKFLOW_PATH_RE.test(path)) {
    for (const match of content.matchAll(WORKFLOW_SCRIPT_REF_RE)) {
      add(match[0], "optional");
    }
    return refs;
  }

  // (b)/(d) A CI script pulls in scripts it imports + the contract package sources behind the
  //         `dist/` build output it imports. Real module edges ⇒ `required`.
  if (SCRIPT_MODULE_RE.test(path)) {
    for (const match of content.matchAll(MODULE_SPECIFIER_RE)) {
      const resolved = resolveRelative(path, match[1] as string);
      if (!resolved) continue;
      const tracked = toTrackedSourcePath(resolved);
      if (
        CONTRACT_PACKAGE_SRC_RE.test(tracked) ||
        SCRIPT_MODULE_RE.test(tracked)
      ) {
        add(tracked, "required");
      }
    }
    return refs;
  }

  // (c) A contract package source pulls in its siblings (the `index.ts` barrel is the whole point)
  //     plus the package's build manifest. Siblings are real edges; the manifest is best-effort.
  const packageSrc = CONTRACT_PACKAGE_SRC_RE.exec(path);
  if (packageSrc) {
    const pkgDir = packageSrc[1] as string;
    for (const match of content.matchAll(MODULE_SPECIFIER_RE)) {
      const resolved = resolveRelative(path, match[1] as string);
      if (!resolved) continue;
      const tracked = toTrackedSourcePath(resolved);
      if (tracked.startsWith(`${pkgDir}/src/`)) add(tracked, "required");
    }
    for (const file of PACKAGE_BUILD_MANIFEST) {
      add(`${pkgDir}/${file}`, "optional");
    }
    return refs;
  }

  // (c cont.) tsup entries are the package's real build entrypoints — a barrel that is never
  //           imported by anything else still has to ship (e.g. a `testing` subpath export).
  const tsupConfig = TSUP_CONFIG_RE.exec(path);
  if (tsupConfig) {
    const pkgDir = tsupConfig[1] as string;
    for (const match of content.matchAll(TSUP_ENTRY_RE)) {
      add(`${pkgDir}/${match[1]}`, "optional");
    }
    return refs;
  }

  return refs;
}

export interface ResolveCanonicalPathClosureInput {
  /** Declared Tier-1 roots. Order is preserved; each is `required`. */
  readonly roots: readonly string[];
  /** Read a repo-relative path at the source ref. `null` ⇒ absent. */
  readonly read: (path: string) => Promise<string | null>;
  /**
   * Called when a `required` path is absent at the source. The adapter throws a typed deploy-plane
   * error here; a caller that returns instead simply drops the path.
   */
  readonly onMissingRequired: (path: string) => void;
  /** Safety valve against a pathological graph. Defaults to 512. */
  readonly maxFiles?: number;
}

/**
 * Walk the roots to a fixpoint, reading each path exactly once, and return every file the fork must
 * receive — in deterministic BFS order (roots first, then what they pull in).
 */
export async function resolveCanonicalPathClosure(
  input: ResolveCanonicalPathClosureInput
): Promise<readonly CanonicalClosureFile[]> {
  const { roots, read, onMissingRequired, maxFiles = 512 } = input;
  const queue: { path: string; requirement: CanonicalPathRequirement }[] = [];
  const indexByPath = new Map<string, number>();
  const skippedAsOptional = new Set<string>();
  const enqueue = (
    path: string,
    requirement: CanonicalPathRequirement
  ): void => {
    const existing = indexByPath.get(path);
    if (existing === undefined) {
      indexByPath.set(path, queue.length);
      queue.push({ path, requirement });
      return;
    }
    if (requirement !== "required") return;
    // An optional (heuristic) discovery upgraded by a real module edge must fail closed —
    // including when the optional read already happened and came back absent.
    const entry = queue[existing];
    if (entry) entry.requirement = "required";
    if (skippedAsOptional.delete(path)) onMissingRequired(path);
  };
  for (const root of roots) enqueue(root, "required");

  const resolved: CanonicalClosureFile[] = [];
  for (let i = 0; i < queue.length; i += 1) {
    if (resolved.length >= maxFiles) break;
    const entry = queue[i];
    if (!entry) continue;
    const { path, requirement } = entry;
    const content = await read(path);
    if (content === null) {
      if (requirement === "required") onMissingRequired(path);
      else skippedAsOptional.add(path);
      continue;
    }
    resolved.push({ path, content });
    for (const ref of deriveReferencedPaths(path, content)) {
      enqueue(ref.path, ref.requirement);
    }
  }

  return resolved;
}

/**
 * Consistency check over a DELIVERED file set: every path the set references but does not contain.
 * Empty ⇒ the set is self-consistent (TIER1_IS_CLOSED). Non-empty ⇒ the fork would receive a workflow
 * that invokes a script it never got, or a barrel that re-exports a module it never got — the exact
 * shape of task.5078. Used by tests to fail a hand-listed set; the closure makes it empty by
 * construction, which is the point.
 */
export function findUnsatisfiedReferences(
  files: readonly CanonicalClosureFile[]
): readonly string[] {
  const delivered = new Set(files.map((file) => file.path));
  const unsatisfied = new Set<string>();
  for (const file of files) {
    for (const ref of deriveReferencedPaths(file.path, file.content)) {
      if (!delivered.has(ref.path)) unsatisfied.add(ref.path);
    }
  }
  return [...unsatisfied].sort();
}
