---
name: node-sync-prs
description: Canonical entry skill whenever a shared change may need to reach sovereign node repositories. Routes package publication, exact package bumps, pinned workflows, fail-closed codemods, literal source ports, and node-owned product changes to separate knowledge atoms.
---

# Node distribution — choose one lane

First recall the fleet-wide safety boundary:

- [Use packages—not fork-wide source sync](https://cognidao.org/knowledge/fork-sync-product-clobber)

Then choose exactly one branch and load its atom before editing:

| situation                                                 | required atom                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Shared behavior has no published package                  | [Publish a shared package](https://cognidao.org/knowledge/publish-shared-runtime-core)             |
| A package already exists and a node needs a newer version | [Adopt one immutable package release](https://cognidao.org/knowledge/adopt-node-package-release)   |
| Literal code must be copied once                          | [Port node source only with a recorded exit](https://cognidao.org/knowledge/port-node-source-once) |
| The repository tree itself must change                    | [Run fleet codemods only fail closed](https://cognidao.org/knowledge/migrate-node-trees-safely)    |
| Shared CI behavior must change                            | [Share node CI through pinned workflows](https://cognidao.org/knowledge/share-node-ci-workflow)    |
| The change is product behavior or branding                | Stop distribution; it is node-owned.                                                               |

Never create a generated or catch-all source-copy PR. Every delivery PR names
the branch atom it follows; uncertainty routes to the literal-source-port atom
and its package-candidate analysis before any copy is made.
