---
id: guide.candidate-flight-v0
type: guide
title: Candidate Flight V0 — Agent Guide
status: deprecated
trust: draft
summary: Legacy guide for the retired PR-number candidate-flight shape; current node flights use nodeRef sourceSha.
read_when: Auditing legacy PR-number candidate-flight mechanics or removing transitional in-repo CI/CD paths.
owner: cogni-dev
created: 2026-04-08
verified: 2026-04-08
tags: [ci-cd, gitops, candidate-flight, agents]
---

# Candidate Flight V0 — Agent Guide

> Legacy reference only. Current node flight is `POST /api/v1/vcs/flight { nodeRef: { nodeId, sourceSha } }`, and the source repo must publish `image_repository:sha-<sourceSha>`.

## Rules

- `main` is the only long-lived code branch.
- The authoritative v0 artifact is the PR head SHA.
- `deploy/candidate-a` is a long-lived bot-written deploy ref.
- Do not auto-flight every green PR.
- A human explicitly chooses which PR to flight now.
- `candidate-flight` is authoritative only for PRs explicitly sent to flight.
- Standard CI/build checks remain the universal merge gate.

## Operator Flow

1. Confirm the PR is green on normal CI/build (`build-images` must have succeeded).
2. Trigger flight explicitly:

   ```bash
   gh workflow run candidate-flight.yml \
     --repo Cogni-DAO/cogni \
     --field pr_number=<PR_NUMBER>
   ```

   Optionally pin a specific SHA:

   ```bash
   gh workflow run candidate-flight.yml \
     --repo Cogni-DAO/cogni \
     --field pr_number=<PR_NUMBER> \
     --field head_sha=<SHA>
   ```

3. Read the lease on `deploy/candidate-a`.
4. If occupied, report `candidate-a busy` and stop. Do not queue.
5. If free or expired, acquire the lease.
6. Push the PR digest to `deploy/candidate-a`.
7. Let Argo sync the stable candidate environment.
8. Run the thin flight checks on the stable candidate URL.
9. Post one aggregate `candidate-flight` result.
10. Release the lease when finished or cancelled.
11. If the PR head changes, rerun flight on the new SHA.

## Required Prototype Checks

- healthy pods
- `/readyz` returns `200` on operator, poly, and resy
- `/livez` returns structured JSON on operator, poly, and resy

## Follow-On Checks

- auth or session sanity path
- one chat or completion path
- one scheduler or worker sanity path
- one or two node-critical APIs

## Hard Boundaries

- No merge queue in v0.
- No dynamic per-PR environments.
- No hidden queue or auto-priority logic.
- No second state plane beyond the lease file for slot truth.
- No rebuild after merge.

## Primary References

- [`docs/spec/ci-cd.md`](../spec/ci-cd.md)
- [`docs/spec/cd-pipeline-e2e.md`](../spec/cd-pipeline-e2e.md)
- [`docs/spec/candidate-slot-controller.md`](../spec/candidate-slot-controller.md)
