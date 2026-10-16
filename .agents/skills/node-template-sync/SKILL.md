---
name: node-template-sync
description: Use when a node-template change must reach existing nodes, when auditing old generated sync PRs, or when automatic fork sync is requested. Source sync is retired; recall the hub distribution contract before acting.
---

# Node-template distribution — recall before acting

Recall the canonical contract and publishing mechanism:

- [Use packages—not fork-wide source sync](https://cognidao.org/knowledge/fork-sync-product-clobber)
- [How Cogni publishes a shared package to node forks](https://cognidao.org/knowledge/publish-shared-runtime-core)

Hard stop: no `node-template` push may write fork source. Do not reactivate,
narrow, or rebuild the retired sync writers. Audit and close old generated sync
PRs, then use the delivery lane selected by the recalled hub contract.
