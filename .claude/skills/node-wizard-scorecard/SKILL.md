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
| Launch pack facts      | node repo URL, parent PR, candidate URL                                  | `pass/blocked` | missing fact to recover                     |
| Parent birth PR        | merged or still open                                                     | `pass/blocked` | wait/ask human to merge parent PR           |
| Child customization PR | PR URL in node repo                                                      | `pass/blocked` | create PR from node repo branch             |
| Child CI               | required checks green                                                    | `pass/blocked` | fix child PR                                |
| Child main image       | `ghcr.io/<owner>/cogni-node-template:sha-<child-sha>` exists after merge | `pass/blocked` | report missing image/tag                    |
| Parent pin             | parent gitlink pins the image-producing child SHA                        | `pass/blocked` | ask operator to update/publish parent pin   |
| Candidate flight       | requested through operator API                                           | `pass/blocked` | call operator flight API only when eligible |
| Candidate verification | candidate `/version` matches launched child SHA                          | `pass/blocked` | validate URL and report                     |

## Rules

- Do not push directly to child `main`.
- Do not hand-edit the operator gitlink from the child-repo agent.
- Do not infer GHCR success from a commit existing; the image tag must exist.
- Do not request flight until the parent pin and child image agree.
- If a gate is blocked by missing operator authority, report the blocker instead
  of inventing a privileged workaround.

## Minimal v0 Path

1. Confirm launch-pack facts.
2. Ensure the parent birth PR is merged or explicitly ask the human to merge it.
3. Open a child node customization PR.
4. Wait for child PR CI, merge, and child `main` image tag.
5. Confirm the parent pin references that image-producing child SHA.
6. Request candidate-a flight through the operator API.
7. Verify candidate `/version` and report the URL.
