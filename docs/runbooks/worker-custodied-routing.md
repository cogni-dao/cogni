---
id: runbook.worker-custodied-routing
type: runbook
title: Explicit production-worker candidate routing release
status: active
trust: draft
summary: Fixed operator service configuration publication, Git receipt rollback, and release proof gates.
owner: cogni-dev
created: 2026-10-22
verified: 2026-10-22
read_when: Publishing or reversing production scheduler-worker candidate routing.
---

# Explicit production-worker candidate routing release

This V0 adds approved candidate aliases through the existing service deploy ref.
It requires a normally delivered operator reader, exact-head independent review
and CI before any production invocation. Unit/contract mocks and a candidate
own-custodian refusal qualify admission behavior; they do not prove the actual
production GitHub write or worker rollout. Node-app flights never invoke it.

## Fixed request and authority

An authenticated operator-node production promoter calls
`POST /api/v1/deploy/infra-reconcile` with exactly:

```json
{
  "nodeId": "<operator UUID>",
  "env": "production",
  "target": "scheduler-worker-custodied-routing"
}
```

The hosting environment and explicit `FLEET_CONTROL_ENV` must both be
`production`. The adapter accepts only its configured parent repository and
operator App installation. Existing requests without `target` retain their
current behavior, including the much broader full-infra replay.

The service resolves protected `main` once, reads the existing generated
`infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml` at
that immutable SHA, and adds only missing aliases in its `cogni-candidate-a`
subsection. The canonical renderer owns roster, custody, UUID and URL derivation.
Slug/UUID pairs must have matching canonical credential-free HTTPS origins.
Duplicate aliases, malformed identity or selected alias repoints refuse.

Only that candidate JSON value changes on the existing
`deploy/production-scheduler-worker` ref. Other YAML bytes, namespaces, primary
routes, images, source pins, secrets and replicas remain intact. Contents file
SHA compare-and-set retries at most three times, rereading immutable current
state. Native Git conflicts exhaust with failure.

`unchanged` means no Git write. `git_published` means the fixed Git transaction
completed; it says nothing about Argo, worker health, pollers or useful work.
The result records authority SHA, deploy commit/ref, before/after blobs,
before/after candidate hashes and the publication receipt commit. Candidate
hashes are SHA-256 of JSON-encoded selected CSV, or JSON `null` when absent.
Keep that full result with the release evidence. Both Toks5 and node-template
are part of the currently observed added-node delta.

## Same-owner receipt rollback

Use the same request plus `"rollbackReceipt":"<publication commit SHA>"`.
No caller restore bytes, repository, ref, source, path or namespace are accepted.
The adapter resolves the receipt and its single parent from the fixed repository,
proves it is in the fixed service ref's history, checks the protected authority's
ancestry and reconstructs the exact additive publication from immutable blobs.
It requires one changed file at the fixed path, strict receipt metadata and
matching before/after blob IDs and candidate hashes.

GitHub's native commit signature must be valid and its author must be
this operator App's bot, including its dynamically resolved numeric identity.
The committer must be that bot or GitHub's exact native `web-flow` signing identity. Contents writes deliberately set no custom
author, committer or signature. Verify the actual native receipt at the first
production publication before calling rollback ready; mocked signature evidence
is insufficient. This follows [GitHub's bot signature requirements](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).

Rollback restores only the recorded prior candidate selection when the live
candidate hash still equals the recorded postchange hash. It preserves unrelated
concurrent comments, namespaces and source/image changes using the current file
SHA. Candidate drift, unverifiable history/signature/receipt or exhausted CAS
refuses. A repeated rollback after restoration is stale and refuses.

The existing worker-image promotion guard preserves its current deploy-ref
`HEAD` candidate subsection exactly after manifest copying. It validates retained
aliases as a subset of freshly pinned protected `main`; it never fills missing
aliases or requires equality. A rollback-selected subset therefore survives
future worker-image promotions. A concurrent service publication causes the
existing non-force image-promotion push to refuse rather than erase it.

## Release evidence

Follow the [reviewed service release proof](https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-29e7215c),
row `worker-routing-release-boundary`, seq16. Require the exact one-field,
signed same-App Git publication and rollback receipts, verified blobs/hashes and
preserved declared production app and worker image/source pins. Require the
correct Argo Application's terminal sync **SUCCESS** at each exact publication
and reversal commit through the maintained controller Loki observation.

For BOTH Toks5 and node-template, require fresh authenticated terminal
Temporal-backed candidate graphs with a new idempotency key/run and unique
marker. Verify the expected namespace/queue from actual submission configuration
and the same worker stream lifecycle. Join actual worker `graph_executing`,
`graph_completed` and final `run_updated` success events by `workflowId`,
`temporalRunId` and `runId`, with the exact node app SHA and node-owned
`traceId`/request logs. A start-phase finalization event does not pass. After
same-owner reapply, repeat both fresh candidate exercises.

Run bounded useful production graph and HTTP probes before, throughout and after
publication, rollout and reversal; compare errors/latency and available
restart/OOM observations with the baseline. Keep production activity authority
and declared pins unchanged. Exercise rollback through the same service owner
and measure restoration; 120 seconds remains a target until observed. All
receipt, immutable authority, provenance, subsection-precondition and CAS gates
above remain required.

Direct ConfigMap hash, desired/live replicas, Pod imageIDs and native Workflow /
Activity poller census are supplementary: mark each **UNKNOWN** when sanctioned
trusted native access is unavailable. Full stored trace retrieval stays
**UNKNOWN** until retrieved; a traceId join alone does not establish it. Missing
exact controller revision, terminal graphs, correlated worker finalization or
production continuity fails the functional gate. Git publication, graph catalog
or boot records, sync-start, readyz and HTTP 200 alone never pass. This establishes
bounded functional convergence, not full substrate **GREEN**, automatic future
node convergence, tenant isolation/budgets or general recovery.
