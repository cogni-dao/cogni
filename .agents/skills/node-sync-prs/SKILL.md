---
name: node-sync-prs
description: Use when shared behavior must reach sovereign node repositories. Automatic template/fork source sync is retired; route pure behavior to versioned packages, CI behavior to pinned reusable workflows, rare physical migrations to fail-closed codemods, and node product changes nowhere.
---

# Node distribution — classify before opening PRs

Automatic node-template-to-fork source writing is retired after bug.5304. Do not recreate it as a smaller allowlist, a three-way merge, or “dependabot for source.” Poly PR #32 proved that template ownership cannot be inferred from path absence or clean mergeability.

## Route the change

1. **Pure shared runtime behavior or contract** → a curated public `@cogni/*` package. Publish immutable semver, then open an exact dependency-bump PR in each consumer.
2. **Shared CI implementation** → a pinned reusable workflow. Node repositories keep thin callers and node-specific inputs.
3. **Physical tree change that neither boundary can express** → a rare reviewed codemod with exact paths, precondition hashes, idempotence, and whole-migration abort on divergence. Until the codemod runner exists, use an ordinary hand-authored per-node PR.
4. **Routes, product features, components, branding, theme, graphs, environment, or runtime wiring** → node-owned. Do not propagate.

Frequent codemods mean the package boundary is wrong. A node is current when its declared compatibility cohort is supported and conformance passes—not when its tree resembles `node-template`.

## Dependency-bump sweep

For a released package version:

1. enumerate active source repositories from the operator registry/catalog plus `Cogni-DAO/node-template`;
2. inspect each repository's manifest and skip consumers that do not use the package;
3. open one ordinary PR per consumer with an exact version pin and lockfile change;
4. require normal CI and candidate validation; never auto-merge;
5. report every target as PR, already-current, non-consumer, or blocked.

The open PRs are the ledger. Do not save a second local tracking file.

## References

- Hub rule: `fork-sync-product-clobber`
- Incident/removal: `bug.5304`
- First package release: `task.5158`
- Canonical contract: `docs/spec/packages-architecture.md` and `docs/spec/repo-sync-contract.md`
