---
name: node-template-sync
description: Use when a node-template change must reach existing node repositories, when auditing old cogni-operator/node-template-{sync,upstream} PRs, or when asking why automatic fork sync did not run. Automatic fork source sync is retired after bug.5304; this skill routes shared behavior to packages/workflows and residual changes to explicit reviewed node PRs.
---

# Node-template distribution — automatic source sync is retired

`node-template` is a birth scaffold and conformance canary. It is **not** an
ongoing source upstream for sovereign node repositories.

## Hard stop

The operator has no template-push fork-sync dispatcher or source-writing port.
A node-template push creates **zero** fork branches and PRs. Both former write
tiers were deleted, not merely disabled:

- `syncCanonicalFilesToFork` — force-overwrote a transitive CI/identity closure.
- `syncTemplateUpstreamToFork` — overlaid every non-`node_local` template blob
  onto the fork and manufactured a conflict-free merge commit.

Do not reactivate, narrow, or rebuild these as a three-way sync. bug.5304 proved
that an exception list cannot safely infer ownership: Poly PR #32 deleted its
copy-trading dashboard, and the same wave rewrote product paths in all five
active forks.

## When asked to propagate a node-template change

Classify the change by delivery lane:

1. **Shared runtime behavior** → put it behind a curated public `@cogni/*`
   package API and bump the node's exact platform cohort version.
2. **CI implementation** → put it in a pinned reusable workflow; node repos keep
   only thin callers and node-specific inputs.
3. **Physical tree change that neither lane can express** → until the versioned
   codemod runner ships, author an ordinary per-node PR. Preserve node product
   behavior, run CI, flight candidate-a, and merge through the operator.
4. **Node product behavior** → do not propagate it. Routes, features,
   components, theme, graphs, environment, and bootstrap choices are node-owned.

Codemods are the rare destination for lane 3: exact paths, precondition hashes,
transactional/idempotent application, abort on divergence, never auto-merge.
Frequent codemods mean the package boundary is wrong.

## Audit old sync PRs

```bash
gh search prs --state open "head:cogni-operator/node-template-sync"
gh search prs --state open "head:cogni-operator/node-template-upstream"
```

Do not merge either class. Inspect the diff for product loss, close the generated
PR, and replace any still-needed change with the appropriate lane above.

## Compatibility rule

Never measure node health by source-tree equality with node-template. A node is
current when its platform compatibility version is supported and its conformance
tests pass. An older divergent tree that passes conformance is decoupled, not
behind.

## References

- Contract: `docs/spec/repo-sync-contract.md` § Automatic Fork Source Sync (Disabled)
- Hub knowledge: `fork-sync-product-clobber`
