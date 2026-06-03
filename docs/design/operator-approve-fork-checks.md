# Operator-as-Maintainer: Auto-Approving Fork-PR Checks

> Status: prototype (v0). Owner: operator node. Links: `nodes/operator/app/src/app/api/v1/vcs/approve-checks/route.ts`, `.claude/skills/git-app-expert/SKILL.md`.

## Problem

External agents (e.g. the `i-am-coco` AI canary node) contribute via **fork PRs**.
GitHub holds every `pull_request` workflow run from a first-time / outside fork
contributor in an `action_required` state — "**N workflows awaiting approval —
This workflow requires approval from a maintainer.**" Until a human clicks
_Approve workflows to run_, CI never starts, so the agent's contract
(`/contribute-to-cogni`) stalls at Phase 1: CI can't go green, so it can't flight,
so it can't `/validate-candidate`. A human is in the critical path of every
external agent's first PR.

Repo policy today: `actions/permissions/fork-pr-contributor-approval =
first_time_contributors`. The gate bites an agent's **first** PR; once one PR from
that fork author merges, GitHub auto-runs its later PRs.

## Goal

Let a **contract-compliant** agent release its own held checks with no human
click — the operator GitHub App acts as the maintainer that approves. Generalises
to all external agents, not just the canary.

## Design

The operator App (`cogni-node-template`, id `3062001`) already holds
`actions: write` on `Cogni-DAO/node-template`. GitHub's
`POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve` requires exactly that
permission, so the App can approve fork runs directly — no new GitHub config.

New surface, mirroring the existing `/api/v1/vcs/flight` shape:

```
POST /api/v1/vcs/approve-checks   { workItemId, prNumber }  → 202 { approved, runIds, headSha, ... }
```

Flow:

1. **Auth** — Bearer (machine agent) or SIWE session. No open access.
2. **Work-item gate** (`assertPrLinkedBySession`) — the named work item must have a
   current session whose `prNumber` matches _and_ whose `claimedByUserId` is the
   calling principal. This reuses the auth chain the agent already built: it linked
   the PR via `POST /work/items/{id}/pr` under its own token. Forge-resistant —
   you can't approve a PR you didn't link, and you can't link one you don't own.
3. **Approve** (`VcsCapability.approveForkChecks`) — resolve the PR head SHA, list
   `action_required` `pull_request` runs for that SHA, `approve` each. Idempotent:
   re-calling after approval returns `approved: 0`.

### Why this gate is safe

Fork `pull_request` runs execute with a **read-only** `GITHUB_TOKEN` and **no
secrets** by default — the approval gate is about runner-minute abuse and running
untrusted code at all, not secret exfiltration. Binding approval to an
authenticated principal who owns a linked work item bounds the abuse surface to
registered agents working tracked items.

### Where it sits in the lifecycle

`approve-checks` runs **before** `flight`. It is the missing Phase-1 step for fork
contributors: open PR → link work item → **approve-checks** → CI runs → CI green →
`flight` → `validate-candidate`. Same-repo branch contributors skip it (no gate).

## Layering

```
packages/node-contracts/src/vcs.approve-checks.v1.contract.ts   wire shape
packages/ai-tools/src/capabilities/vcs.ts                       VcsCapability.approveForkChecks (interface)
nodes/operator/app/src/adapters/server/vcs/github-vcs.adapter.ts Octokit impl (list action_required → approve each)
nodes/{operator,canary,resy,node-template}/.../capabilities/vcs.ts stubs throw
nodes/operator/app/src/app/_facades/work/coordination.server.ts assertPrLinkedBySession (gate)
nodes/operator/app/src/app/api/v1/vcs/approve-checks/route.ts   HTTP route
```

## Alternatives considered

- **Make the canary a collaborator / org member.** Zero code: an org member's fork
  PRs (or branches pushed to the main repo) never hit the gate. Cleanest _for the
  canary alone_, but doesn't generalise to arbitrary external agents and grants
  standing write. Kept as the human-config fallback if App-approval ever regresses.
- **Webhook-driven auto-approve** on `pull_request.opened`. No explicit agent call,
  but push-model and harder to reason about/test. `approve-checks` is the pull-model
  v0; a webhook trigger can call the same facade later.
- **Loosen repo policy** to `first_time_contributors_who_are_new_to_github`. Weakens
  the gate for _everyone_, including genuine outside humans. Rejected.

## Not in v0

- Optional stronger gate: require a linked knowledge contribution / Dolt spec on the
  work item before approving (`contribute-knowledge-to-cogni`). Trivial to add as a
  flag once the knowledge-link is queryable server-side.
- An AI tool (`core__vcs_approve_fork_checks`) for in-graph use by `pr-manager`.
- Per-app concurrency / rate limiting on approvals.

## Human actions required (repo config)

1. **None for the App permission** — `actions: write` is already approved (verified
   live 2026-06-03).
2. **Decide the gate posture.** v0 ships the work-item + principal gate. If you also
   want a knowledge-link requirement, say so and it's a one-line addition.
3. **Optional canary shortcut** — if you'd rather the `i-am-coco` identity skip the
   gate entirely, add it as an org member/collaborator; this endpoint then only
   matters for _other_ external agents.
