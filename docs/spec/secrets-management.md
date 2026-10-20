---
id: spec.secrets-management
type: spec
title: Secrets Management — Hub Pointer
status: superseded
trust: reviewed
summary: Compatibility pointer to the migrated secrets contract and node procedure.
read_when: Adding or rotating a secret, changing custody or projection, or following an older secrets reference.
owner: derekg1729
created: 2026-05-19
verified: 2026-10-20
---

# Secrets management

<!-- Preserve inbound section links while their consumers move to the hub. -->

<a id="context"></a>
<a id="goal"></a>
<a id="non-goals"></a>
<a id="authority-model"></a>
<a id="new-node-wizard-contract"></a>
<a id="core-invariants"></a>
<a id="design"></a>
<a id="path-convention"></a>
<a id="consumption-pattern--externalsecret-with-datafrom-extract"></a>
<a id="consumption-pattern--pod-spec"></a>
<a id="db-credential-provisioning--the-composek8s-boundary-bug5002-invariant-15"></a>
<a id="e2e-validation-contract-phases-12-on-candidate-a"></a>
<a id="optional-service--writing-a-platform-service-bucket"></a>
<a id="value-classification--three-orthogonal-axes"></a>
<a id="rotation-lifecycle-per-nist-sp-800-57-8-key-states"></a>
<a id="rbac-policy-templates"></a>
<a id="soc-2-mapping"></a>
<a id="anti-patterns-reviewer-will-reject"></a>
<a id="file-pointers"></a>
<a id="related"></a>
<a id="e2e-validation--the-self-serve-proof"></a>
<a id="docs-hygiene"></a>
<a id="acceptance"></a>

[Canonical contract: secrets custody and delivery](https://cognidao.org/knowledge/secrets-management).

<a id="self-serve-model-read-this-first"></a>
<a id="standardized-tooling--three-entry-points-one-primitive"></a>
<a id="entry-1--cli-developer-interactive"></a>
<a id="entry-2--github-workflow-ops-audit-logged"></a>
<a id="entry-3--operator-api-node-owner-self-serve-openfga-authorized"></a>

[Node procedure: add or rotate a secret](https://cognidao.org/knowledge/node-self-serve-secrets).

Agents: use the operator's saved credential to read
GET /api/v1/knowledge/secrets-management; for node operations also read
GET /api/v1/knowledge/node-self-serve-secrets. Read each response's full content,
including its required dependencies. Failed retrieval is not an empty contract.

<a id="migration--phased-each-phase-independently-shippable"></a>
<a id="implementation-split"></a>

[Original source and historical phases](https://github.com/cogni-dao/cogni/blob/7dd438da8a30b49a2e3e5de97d2a4b704b17e48c/docs/spec/secrets-management.md)
· [Migration coverage and evidence](https://cognidao.org/work/items/story.5093).
