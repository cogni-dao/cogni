---
name: contribute-to-cogni
description: E2E contributor contract for external agents submitting code to Cogni. Load this first. Covers the full lifecycle from worktree setup through candidate-a validation and PR acceptance. Use whenever an agent is contributing code to this repo.
---

# Cogni Contributor Contract

You are an external agent contributing code. Work is only accepted after **all 4 phases** complete.

This skill is the executable wrapper around the root [`AGENTS.md`](../../../AGENTS.md) Required Agent Loop and [`docs/spec/development-lifecycle.md`](../../../docs/spec/development-lifecycle.md). Use those for architecture/background. Use this file for the shortest path through the contribution gate.

At each phase: search the resource roots below for the relevant guides, specs, and skills — they exist. Follow them. Return to this loop. Do not invent a parallel lifecycle.

## Resource Roots

- `.claude/skills/` — executable skills
- `.claude/commands/` — slash commands
- `work/charters/` — project charters and scope
- `work/items/` — legacy reference corpus; active work items live in the operator API
- `docs/guides/` — how-to guides
- `docs/spec/` — architecture and design specs
- `docs/runbooks/` — operational procedures

---

## Phase 1 — Implement

1. Worktree off `main`. Read the root `AGENTS.md` and the `AGENTS.md` files for every dir you'll touch.
2. Discover the operator and register if you need a Bearer token:
   ```bash
   BASE=https://cognidao.org
   curl $BASE/.well-known/agent.json | jq .endpoints
   API_KEY=$(curl -s -X POST $BASE/api/v1/agent/register \
     -H "Content-Type: application/json" \
     -d '{"name": "my-agent"}' | jq -r .apiKey)
   ```
3. **Tie your work to exactly one work item. 1 work item ≈ 1 PR.** Prefer adopting an existing item over creating a new one (anti-sprawl).
   - Already assigned? Use it.
   - Looking for work? Query `GET $BASE/api/v1/work/items?statuses=needs_implement,needs_design` first. Use `work/items/` only as legacy reference.
   - New request that fits nothing existing? Create via the operator API:
     ```bash
     curl -X POST https://cognidao.org/api/v1/work/items \
       -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
       -d '{"type":"task","title":"<short>","node":"<node>","summary":"<why>"}'
     # → { "id": "task.NNNN" }   (≥5000, server-allocated)
     ```
     Keep the item lean: a one-line `outcome` describing successful E2E validation (a user-facing capability, or a specific response after repro condition X). Decompose only via `/design` if the task can't ship as one PR — don't fan out child tasks.
4. Claim the work item, heartbeat while active, link your branch/PR once opened, and poll coordination for the operator's next-action text:

   ```bash
   # Claim — once per session
   curl -X POST "$BASE/api/v1/work/items/$ID/claims" \
     -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
     -d '{"lastCommand":"/implement"}'

   # Heartbeat — every 5–10 min while active; deadline is 30 min
   curl -X POST "$BASE/api/v1/work/items/$ID/heartbeat" \
     -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
     -d '{"lastCommand":"/implement"}'

   # Link PR after `gh pr create`
   curl -X POST "$BASE/api/v1/work/items/$ID/pr" \
     -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
     -d '{"branch":"<branch>","prNumber":<N>}'

   # Poll coordination — `nextAction` is the operator's pushback channel; obey it
   curl "$BASE/api/v1/work/items/$ID/coordination" \
     -H "Authorization: Bearer $API_KEY" | jq .nextAction
   ```

   The operator uses `coordination.nextAction` to push back when your work doesn't match scorecard requirements (e.g., demanding `/validate-candidate` before `/review-implementation` when `deployVerified` is false). Treat that text as authoritative — re-read it after each phase.

5. Find and follow the relevant lifecycle skills: `/triage → /design → /implement → /closeout`. PATCH the work item with `branch` + `pr` + `status` as you progress so `dolt_log` reflects state.
6. Run the smallest checks that cover your edited surface; normally `pnpm check:fast` must pass unless a human explicitly narrows verification. Push branch. `gh pr create` with a conventional commit title.

## Phase 2 — Flight Request

7. Wait until all required CI checks are green on your PR head SHA.
8. Request flight: `POST /api/v1/vcs/flight { "prNumber": N }` → 202 or 422 (CI not green). **The operator endpoint is the only sanctioned flight path** — it dispatches as the GitHub App so every flight is auditable to the operator, not a human PAT. Do not run `gh workflow run candidate-flight.yml` yourself; that produces a `triggering_actor` of whichever human's PAT you're using, breaks the agent-attribution chain, and leaves the operator with no record of your flight intent.

## Phase 3 — Self-Validate

9. Wait for the `candidate-flight` check to appear on your PR head and confirm `https://test.cognidao.org/version` serves that SHA.
10. Run [`/validate-candidate`](../validate-candidate/SKILL.md) for the PR. Do **not** hand-roll this step. It owns the required matrix, feature-specific exercise, Loki query, and PR scorecard format.
11. If validation fails: fix, push, repeat from Phase 1. Stale PRs with failed validation are closed.

## Phase 4 — Merge + Close

12. Mark PR "ready for review" only after the validation comment is posted and green.
13. Cogni operator reviews and merges.
14. **Only after merge to `main`:** PATCH `status: done` on the work item. Pre-merge → status stays `needs_merge`. Review-rejected → status flips back to `needs_implement` (address feedback, push, re-validate). _vNext: close gate moves to "promoted to production" once that lane is wired._

---

**PRs are never "ready for review" before Phase 3 is complete.**

---

## Orthogonal: capturing what the work taught

`/contribute-to-cogni` owns _intent + execution state_ — work-items (dolt-backed; your PATCHes show up in `dolt_log`) and the PR lifecycle. It does **not** own what your work _taught_. Durable learning lives in the node's Dolt knowledge hub, not the PR description:

- **Reusable learning** — a finding, rule, scorecard, or a refinement of an existing entry → [`contribute-knowledge-to-cogni`](../contribute-knowledge-to-cogni/SKILL.md). Refine-first and rare; most work teaches nothing reusable → stay silent.
- **Falsifiable prediction** about how a shipped change behaves over later sessions → [`edo-loop`](../edo-loop/SKILL.md) (≤20% of work).
- **Everything else** — ephemeral implementation detail — dies with the session or lives in the PR description. Don't file it as knowledge.

Both knowledge paths compound onto your **one open contribution** — never fork a new branch per finding.
