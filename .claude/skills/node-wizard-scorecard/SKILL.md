---
name: node-wizard-scorecard
description: Use when an agent receives a Cogni node wizard launch pack, takes over a newly published throwaway node, or must prove the node-wizard launch path end-to-end across child customization PR, child CI/image, parent pin, operator flight request, and candidate /version verification.
---

# Node Wizard Scorecard

Use this as the first response after receiving a node launch pack. The goal is
not to save the throwaway node; the goal is to prove the node-wizard launch path
is reproducible by an external agent without privileged manual bridges.

## Setup

If the workspace root does not contain `.env.cogni`, run
`/contribute-to-cogni` against the production operator and save the returned env
file at the repo root before doing launch work. Use that token to recall the
launch handoff knowledge block and agent starter-kit knowledge before designing
the customization PR.

## First Response

Do not send the full matrix before a child customization PR exists. Before that
point, report only launch facts plus the next concrete action. A status table
with `READY` rows is misleading because the path has not produced a deployable
artifact and human merge latency may still be ahead.

Pre-PR first response:

```markdown
Launch facts:

- node repo:
- parent PR:
- candidate URL:

Current gate: child customization PR not opened
Next action: create a minimal node repo PR and report its URL
```

Humans may send only a repo URL, parent PR, or short status fragment. Recover
the rest from GitHub/operator state; do not ask the human to fill out the
scorecard.

## Required Matrix

Return this matrix only after the child customization PR exists, or when
reporting a terminal blocker that prevents opening one:

| Gate                   | Evidence                                                         | Status         | Next action                                 |
| ---------------------- | ---------------------------------------------------------------- | -------------- | ------------------------------------------- |
| Launch pack facts      | node repo URL, parent PR, candidate URL                          | `pass/blocked` | missing fact to recover                     |
| Parent birth PR        | merged or still open                                             | `pass/blocked` | wait/ask human to merge parent PR           |
| Child customization PR | PR URL in node repo                                              | `pass/blocked` | create PR from node repo branch             |
| Child CI               | required checks green                                            | `pass/blocked` | fix child PR                                |
| Child main image       | `ghcr.io/<owner>/<repo>:sha-<child-main-sha>` exists after merge | `pass/blocked` | report missing image/tag                    |
| Parent pin             | parent gitlink pins the image-producing child main SHA           | `pass/blocked` | ask operator to update/publish parent pin   |
| Candidate flight       | requested through operator API                                   | `pass/blocked` | call operator flight API only when eligible |
| Candidate verification | candidate `/version` matches launched child SHA                  | `pass/blocked` | validate URL and report                     |

## Rules

- Do not push directly to child `main`.
- Do not merge your own child or parent PR. Stop at ready/mergeable and report
  the human/operator merge row as pending.
- Do not hand-edit the operator gitlink from the child-repo agent.
- Do not infer GHCR success from a commit existing; the image tag must exist.
- Do not request flight until the parent pin and child image agree.
- Candidate flight must be requested through the operator API. Do not use
  source-repo deploy workflows or other privileged manual deploy paths.
- After merge, use the child repo's current `main` SHA as `sourceSha`. GitHub
  merge commits differ from PR head commits, and the child push build tags
  `sha-${github.sha}`.
- If a gate is blocked by missing operator authority, report the blocker instead
  of inventing a privileged workaround.

## Human Scorecard Timing

Do not present the node formation scorecard to the human until candidate flight
has succeeded and the candidate URL has been validated. The human-facing report
must include critical repo links, child PR/check status, image tag and digest,
parent pin status, flight status, candidate `/version`, and a short explanation
of the child-build -> operator-pin -> candidate-flight CI/CD path. Use
`docs/spec/node-ci-cd-contract.md` for the CI/CD facts and
`docs/guides/agent-api-validation.md` for the post-flight API exercise.

## Minimal v0 Path

1. Confirm launch-pack facts and recall the knowledge handoff.
2. Ensure the parent birth PR is merged or explicitly ask the human to merge it.
3. Open a child node customization PR.
4. Wait for child PR CI, human/operator merge, and child `main` image tag.
5. Confirm the parent pin references that image-producing child SHA.
6. Request candidate-a flight through the operator API.
7. Verify candidate `/version` and run agent-first API validation.
8. Present the node formation scorecard to the human.
