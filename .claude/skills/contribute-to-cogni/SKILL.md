---
name: contribute-to-cogni
description: E2E contributor contract for external agents submitting code AND durable knowledge to Cogni. Load this first. Covers the full lifecycle from worktree setup through candidate-a validation and PR acceptance, plus capturing reusable insight in the knowledge hub instead of inline comments or .md sprawl. Use whenever an agent is contributing to this repo.
---

# Cogni Contributor Contract

You are an external agent contributing to Cogni. A contribution is **two artifacts in two lanes**: the **code** (git, gated by the 4 phases below) and the **durable knowledge** it produced (the hub). Code is accepted after **all 4 phases** complete; knowledge ships through the same PR when the change earned it.

This skill is the executable wrapper around the root [`AGENTS.md`](../../../AGENTS.md) Required Agent Loop and [`docs/spec/development-lifecycle.md`](../../../docs/spec/development-lifecycle.md). Use those for architecture/background. Use this file for the shortest path through the contribution gate.

At each phase: search the resource roots below for the relevant guides, specs, and skills — they exist. Follow them. Return to this loop. Do not invent a parallel lifecycle.

## Knowledge is the documentation layer

Code carries _what_ via names + types. The **knowledge hub** carries the _why_ + the reusable design insight a future agent needs — **not** inline comments narrating code, and **not** new `docs/*.md` files. Both are entropy (root `AGENTS.md` anti-patterns); durable docs go to the hub via [`contribute-knowledge-to-cogni`](../contribute-knowledge-to-cogni/SKILL.md).

**The bar is high.** Most PRs produce **no** knowledge entry — ephemeral context dies with the session, and ≥80% of "this feels worth writing" moments should stay silent (that skill's action hierarchy). Write only when the insight is durable, reusable, and not recoverable from the code itself; prefer **refining** an existing entry over adding one.

**When you do document, split by audience and link them:**

- **AI-detailed text = canonical.** A markdown atom — full detail + pointers, the source of truth agents recall. Markdown renders for humans too, so this alone usually suffices.
- **Human-simple visual = optional.** An `entryType=html` artifact that **`cites`** the text atom — catchy, scannable, per [`docs/spec/knowledge-html-style.md`](../../../docs/spec/knowledge-html-style.md). An html block is human-only (AI can't read it well), so it must never be a claim's only home.
- The html's confidence is **capped by its cited source**; periodic human+AI review walks the citation to keep them accuracy-aligned.

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
8. Request flight through the current deploy lane:
   - For externally built node artifacts, call the operator primitive:
     `POST /api/v1/vcs/flight { "nodeRef": { "nodeId": "<uuid>", "sourceSha": "<40-char sha>" } }`.
   - For in-repo monorepo PRs, follow `coordination.nextAction` / the PR-manager lane. The candidate-flight workflow still accepts transitional `pr_number` inputs because in-repo build artifacts are PR-shaped, but `prNumber` is not the REST endpoint contract.
   - Do not bypass the operator/policy lane unless a human explicitly asks you to diagnose a broken flight path; direct `gh workflow run candidate-flight.yml` uses the caller's GitHub actor and should be treated as an exception with a linked bug.

## Phase 3 — Self-Validate

9. Wait for the `candidate-flight` check to appear on the flown source and confirm `https://test.cognidao.org/version` serves that SHA.
10. Run [`/validate-candidate`](../validate-candidate/SKILL.md) for the PR. Do **not** hand-roll this step. It owns the required matrix, feature-specific exercise, Loki query, and PR scorecard format.
11. If validation fails: fix, push, repeat from Phase 1. Stale PRs with failed validation are closed.

## Phase 4 — Merge + Close

12. Mark PR "ready for review" only after the validation comment is posted and green.
13. Cogni operator reviews and merges.
14. **Only after merge to `main`:** PATCH `status: done` on the work item. Pre-merge → status stays `needs_merge`. Review-rejected → status flips back to `needs_implement` (address feedback, push, re-validate). _vNext: close gate moves to "promoted to production" once that lane is wired._
15. **Capture durable knowledge — if any.** Before closing, ask: did this change produce a reusable insight a future agent will need and can't recover from the code? If yes → file it via [`contribute-knowledge-to-cogni`](../contribute-knowledge-to-cogni/SKILL.md) (refine first; AI-text canonical, optional human-html that cites it). If no → ship nothing. No entry is the common, correct case — this is a prompt, not a gate.

---

**PRs are never "ready for review" before Phase 3 is complete.**

---

## Orthogonal: capturing what the work taught

`/contribute-to-cogni` owns _intent + execution state_ — work-items (dolt-backed; your PATCHes show up in `dolt_log`) and the PR lifecycle. It does **not** own what your work _taught_. Durable learning lives in the node's Dolt knowledge hub, not the PR description:

- **Reusable learning** — a finding, rule, scorecard, or a refinement of an existing entry → [`contribute-knowledge-to-cogni`](../contribute-knowledge-to-cogni/SKILL.md). Refine-first and rare; most work teaches nothing reusable → stay silent.
- **Falsifiable prediction** about how a shipped change behaves over later sessions → [`edo-loop`](../edo-loop/SKILL.md) (≤20% of work).
- **Everything else** — ephemeral implementation detail — dies with the session or lives in the PR description. Don't file it as knowledge.

Both knowledge paths compound onto your **one open contribution** — never fork a new branch per finding.
