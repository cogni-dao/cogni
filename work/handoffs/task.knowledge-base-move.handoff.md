---
id: task.knowledge-base-move.handoff
type: handoff
status: active
created: 2026-05-19
branch: derekg1729/handoff-knowledge-base-move
last_commit: 06e9bb305
---

# Handoff: Move `@cogni/node-template-knowledge` → `@cogni/knowledge-base` (shared)

## Context

The base knowledge Drizzle schema (`knowledge`, `domains`, `sources`, `citations`, `knowledge_contributions`) currently lives at `nodes/node-template/packages/knowledge/` under the name `@cogni/node-template-knowledge`. It's a **shared** package — consumed by `nodes/operator/` and `scripts/db/`, not by node-template itself in any node-specific way. Living inside `nodes/node-template/` is an architectural smell (cross-node imports), and reading the package name suggests it's node-template's own when it's really the canonical syntropy seed bundle every knowledge-capable node inherits.

This task moves it to its proper home: `packages/knowledge-base/` under the name `@cogni/knowledge-base`. Pure hygiene, no semantic change.

## Scope

### In cogni (this repo) — the source-of-truth move

1. **`git mv nodes/node-template/packages/knowledge/ packages/knowledge-base/`** — preserve git history.
2. **Rename the package**: `nodes/node-template/packages/knowledge/package.json` `"name": "@cogni/node-template-knowledge"` → `packages/knowledge-base/package.json` `"name": "@cogni/knowledge-base"`.
3. **Update self-references in the moved source** (`src/index.ts`, `src/schema.ts`, `src/seeds/{base,domains}.ts`) — JSDoc `@module` comments that say `@cogni/node-template-knowledge/...`.
4. **Update consumers in cogni**:
   - `nodes/operator/packages/doltgres-schema/package.json` — `"@cogni/node-template-knowledge": "workspace:*"` → `"@cogni/knowledge-base": "workspace:*"`.
   - `nodes/operator/packages/doltgres-schema/tsup.config.ts` — `external: [..., "@cogni/node-template-knowledge"]` → `... "@cogni/knowledge-base"]`.
   - `nodes/operator/packages/doltgres-schema/src/knowledge.ts` — `from "@cogni/node-template-knowledge"` → `from "@cogni/knowledge-base"`.
   - `scripts/db/seed-doltgres.mts` — `import("@cogni/node-template-knowledge")` + the warning string.
5. **Root config**:
   - `package.json` root `dependencies` — `"@cogni/node-template-knowledge": "workspace:*"` → `"@cogni/knowledge-base": "workspace:*"`.
   - `tsconfig.json` `references` — `{ "path": "./nodes/node-template/packages/knowledge" }` → `{ "path": "./packages/knowledge-base" }`.
   - `pnpm-workspace.yaml` — confirm `packages/*` glob is already there (it is); no edit needed unless explicit allowlist exists.
6. **Regenerate `pnpm-lock.yaml`**: `pnpm install --lockfile-only`.
7. **Audit for stragglers**: `rg '@cogni/node-template-knowledge'` should return zero matches in cogni after the change (except possibly historical references in `work/handoffs/` and `docs/research/` — leave those, they're history).

### Cross-repo propagation (CRITICAL)

cogni has two downstream consumers of structural changes:

#### Cogni-DAO/node-template (public template repo)

- Lineage: **forked from cogni** (`git remote upstream = Cogni-DAO/cogni`).
- After cogni merges this PR, node-template's main is behind by one structural change. The node-template owner runs `git merge upstream/main` to absorb it. Conflicts will appear ONLY on the moved paths — they're mechanical to resolve (use the upstream version).
- node-template's nodes/ contains a single fixture node also called `node-template`. After upstream merge:
  - `nodes/node-template/packages/knowledge/` is gone (moved to `packages/knowledge-base/`).
  - `nodes/node-template/app/` and other paths still consume `@cogni/knowledge-base`.
  - If `scripts/rename-node.sh <new-name>` (the fork-rename helper) references the old package name, update the substitution rules.
- **Tag the cogni PR with the `needs-upstream-sync` label** (or equivalent — see cogni-poly's convention) so the node-template owner sees it in their backlog.

#### Cogni-DAO/cogni-poly (private, independent — NOT a fork)

- cogni-poly already inlined the equivalent package as `@cogni/poly-knowledge` at `nodes/poly/packages/knowledge/` during the original repo split (Phase 0 step 0.7, cogni-poly PR #12).
- **No structural propagation needed.** cogni-poly is single-node — the "shared base" abstraction doesn't apply. It keeps its self-contained `@cogni/poly-knowledge`.
- BUT: if you find any semantic change in the schema (new column, new index, changed default) during this move, that semantic delta should propagate to cogni-poly's `@cogni/poly-knowledge`. Pure-move PRs have no semantic delta → no cogni-poly action.
- Apply the cogni-poly `needs-upstream-sync` label convention in reverse here: if this PR introduces any schema change beyond the move, file a follow-up sync PR on cogni-poly.

## Acceptance Criteria

1. ✅ `git mv` preserves history (verify with `git log --follow packages/knowledge-base/src/schema.ts`).
2. ✅ `rg '@cogni/node-template-knowledge' --type ts --type json` returns zero matches in cogni source (history docs OK).
3. ✅ `pnpm install` succeeds; `pnpm packages:build` returns "✓ All N packages have declarations".
4. ✅ Required CI gates green (`unit`, `component`, `static`, `manifest`).
5. ✅ `nodes/operator/packages/doltgres-schema` still type-checks (it re-exports knowledge tables — break case is high signal).
6. ✅ `scripts/db/seed-doltgres.mts` runs end-to-end against a test doltgres (manual or via a stack test).
7. ✅ PR labeled `needs-upstream-sync` (or labeled with cogni's equivalent) so node-template's owner picks it up.

## Expected CI surprises

- `tests/ci-invariants/single-node-scope-parity.spec.ts` — fixtures may reference the old path. Audit `tests/ci-invariants/fixtures/single-node-scope/*.json` for `nodes/node-template/packages/knowledge/`; substitute `packages/knowledge-base/` where it appears.
- Workspace declaration validation (`scripts/validate-package-declarations.ts`) reads tsconfig.json references — update before this runs.

## Out of scope

- **Don't change the schema** — no column adds, no domain seed additions. Pure move + rename only.
- **Don't touch cogni-poly's `@cogni/poly-knowledge`** unless you discover a schema delta this PR introduces (which should be zero).
- **Don't move other potentially-shared packages** (e.g., `@cogni/knowledge-store`) in the same PR — keep scope tight.

## References

- [`docs/spec/knowledge-data-plane.md`](../../docs/spec/knowledge-data-plane.md) — knowledge plane architecture
- [`docs/spec/knowledge-syntropy.md`](../../docs/spec/knowledge-syntropy.md) — Doltgres-side invariants
- [`docs/guides/node-removal.md`](../../docs/guides/node-removal.md) — as-built playbook from Phase 0 step 0.8 (related repo-split context)
- cogni-poly PR #12 — the inline-instead-of-share decision for single-node repos
- task.0311 — earlier work introducing `@cogni/node-template-knowledge` as a shared package living inside `nodes/node-template/`

## Notes for the implementing dev

- Branch already exists: `derekg1729/handoff-knowledge-base-move` (off main @ `06e9bb305`).
- This is **pure hygiene**. If you find yourself wanting to also fix something else in this PR, file a separate task — keep the diff laser-focused on the move.
- The change is reversible via `git revert` if anything downstream breaks unexpectedly.
- Estimated effort: 1-2 hours, mostly verification.
