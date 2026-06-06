---
name: node-wizard-scorecard
description: Use when an agent receives a Cogni node wizard launch pack, takes over a newly published throwaway node, or must prove the node-wizard launch path end-to-end across child customization PR, child CI/image, parent pin, operator flight request, and candidate /version verification.
---

# Node Wizard Scorecard

Use this as the first response after receiving a node launch pack. The goal is
not to save the throwaway node; the goal is to prove the node-wizard launch path
is reproducible by an external agent without privileged manual bridges.

## Required Matrix

Return this matrix before editing code:

| Gate                   | Evidence                                                                 | Status         | Next action                                 |
| ---------------------- | ------------------------------------------------------------------------ | -------------- | ------------------------------------------- |
| Launch pack facts      | node repo URL, parent PR, candidate URL                                  | `pass/in_progress/blocked` | missing fact to recover                     |
| Parent birth PR        | merged, queued, or still checking                                        | `pass/in_progress/blocked` | monitor/ask human to merge; do not idle if node repo is available |
| Child customization PR | PR URL in node repo                                                      | `pass/in_progress/blocked` | create PR from node repo branch immediately |
| Child CI readiness     | workflow enabled, workflow run observable, GHCR auth path present        | `pass/in_progress/blocked` | report missing workflow run or image auth   |
| Child CI               | required checks green                                                    | `pass/in_progress/blocked` | fix child PR                                |
| Child main image       | `ghcr.io/<owner>/cogni-node-template:sha-<child-sha>` exists after merge | `pass/in_progress/blocked` | report missing image/tag                    |
| Parent pin             | parent gitlink pins the image-producing child SHA                        | `pass/in_progress/blocked` | ask operator to update/publish parent pin   |
| Candidate flight       | requested through operator API                                           | `pass/in_progress/blocked` | call operator flight API only when eligible |
| Candidate verification | candidate `/version` matches launched child SHA                          | `pass/in_progress/blocked` | validate URL and report                     |

## Parallel Work Rule

The parent birth PR merge gates deployability, not child customization. If the
parent PR is open, in CI, in merge queue, or waiting for a human merge, mark
`Parent birth PR` as `in_progress`, keep monitoring it, and immediately proceed
with the child customization PR when the node repo URL is present and writable.

Only stop before child customization when a real prerequisite is absent: missing
node repo URL, inaccessible node repo, missing contributor auth, or an explicit
operator `coordination.nextAction` that forbids child work.

## Candidate Evidence Rule

Localhost is never E2E launch evidence. A local dev server may help implement or
inspect the child customization PR, but it does not advance `Child CI`, `Child
main image`, `Parent pin`, `Candidate flight`, or `Candidate verification`.
Those rows require GitHub CI, GHCR image evidence, the operator pin/flight path,
and the real candidate URL from the launch pack.

If child image publication is blocked because the child repo workflow did not
run, inspect and report the GitHub workflow trigger/check state. Do not replace
that blocker with a local server.

## Child CI Readiness Rule

The node repo must be born with CI ready to enqueue without manual clicks:
Actions enabled, the Node CI workflow active on the default branch, a visible
push or pull_request run after the first node-local PR, and a GHCR auth path for
the push-to-main image build. If the workflow exists but GitHub reports zero
runs, `Child CI readiness` is blocked.

## Rules

- Do not push directly to child `main`.
- Do not hand-edit the operator gitlink from the child-repo agent.
- Do not infer GHCR success from a commit existing; the workflow run and image
  tag must exist.
- Do not report `localhost` as the candidate URL or as proof of launch success.
- Do not request flight until the parent PR is merged and the parent pin and
  child image agree.
- If a gate is blocked by missing operator authority, report the blocker instead
  of inventing a privileged workaround.

## Minimal v0 Path

1. Confirm launch-pack facts.
2. Start a watcher on the parent birth PR; if it is open or queued, mark it
   `in_progress`, ask the human to merge if needed, and continue.
3. Open a child node customization PR without waiting for the parent merge.
4. Confirm child CI readiness: workflow run visible and GHCR auth path present.
5. Drive child PR CI while the parent PR merges.
6. After child PR merge, wait for the child `main` image tag.
7. Confirm the merged parent pin references that image-producing child SHA.
8. Request candidate-a flight through the operator API.
9. Verify candidate `/version` and report the URL.
