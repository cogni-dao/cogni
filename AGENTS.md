# AGENTS.md — Cogni-Template

> Repo-wide orientation. Subdir `AGENTS.md` extends; closest file wins ([agents.md spec](https://agents.md/)). Each `nodes/<node>/AGENTS.md` defines that node's rules — read it once you know your scope.

You are an agent inside a multi-agent system. The **operator** (`https://cognidao.org`) is your coordinator for code + docs updates, flighting, and validation reports. Whether you run hosted or as a Claude Code / Conductor session on a human's laptop, the contract is the same: every code change flows through the operator.

## Required Loop

1. Adopt exactly one production work item and one node (`single-node-scope` is a CI gate; cross-node ⇒ separate item). Active work lives in the operator API. Read `nodes/<node>/AGENTS.md` for that node's rules. **Recall the node's knowledge hub before designing or researching** — a prior agent may already have the finding (`RECALL_BEFORE_WRITE`; see [`/contribute-knowledge-to-cogni`](.claude/skills/contribute-knowledge-to-cogni/SKILL.md)).
2. Claim + heartbeat + link PR via `/api/v1/work/items/$ID/{claims,heartbeat,pr,coordination}`. **`coordination.nextAction` is authoritative** — re-read it after each phase and let it override your plan.
3. Align the design. Find the most relevant design specs, guides, skills, and prior code for your feature space. Run a review-design pass before changing code, then refine existing artifacts instead of adding parallel ones.
4. Implement on the feature branch. This repo has strict typechecking and linting: commit frequently, review your implementation, and iterate. Trust automated checks to verify cleanliness — configured pre-push gates and GitHub CI runs. Push, monitor `gh pr checks` to green, and use CI wait time to self-review with a review-implementation pass against your own diff.
5. Validate end-to-end. Return to the core goal of your code and prove it through the real candidate deployment: after CI green, use the correct flight lever for the artifact. In-repo operator app PRs dispatch `candidate-flight.yml -f pr_number=$PR_NUMBER`; externally built node artifacts call `POST /api/v1/vcs/flight { nodeRef: { nodeId, sourceSha } }`. Then run [`/validate-candidate`](.claude/skills/validate-candidate/SKILL.md) against the deployed build and the specific PR-touched surfaces. Candidate flighting is the primary E2E environment; do not start local dev servers unless the user explicitly asks. Use the skill's scorecard format; post it to the PR before requesting implementation review.
6. Hand off to the human with a TL;DR: goal, relevant prior design/code, code added, PR link, scorecard link, candidate-flight link, candidate URL, and what is newly visible or exercisable there.
7. Close only after merge. Pre-merge work stays `needs_merge`; `status: done` means merged to `main`. Before closing, refine durable knowledge back into the hub only if the work produced reusable insight; most PRs should add no knowledge entry.
8. Hit a contract blocker (auth, broken endpoint, invariant you can't satisfy)? File a bug: `POST /api/v1/work/items {type:'bug', node:'operator'}`, link from your active item.

> Bearer token expected. New contributors register once via [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md); existing agents reuse the saved token.

## Definition of Done

`status: done` ⇔ code merged. PRs are not ready for implementation review until the candidate scorecard is posted. **Code only merges after both**:

1. Full green: reviewed implementation + CI green on the PR.
2. `deploy_verified: true` — flighted to candidate-a, `/validate-candidate` scorecard posted, your own request observed in Loki at the deployed SHA.

Two named human stops may appear: `needs_review` for design review before implementation, and `needs_human_qa` after candidate validation. Do not request implementation review until the `/validate-candidate` scorecard is on the PR.

Durable learning the work produced is **refined back into the hub** (recall → refine in place > write new), not buried in the PR — see [`/contribute-knowledge-to-cogni`](.claude/skills/contribute-knowledge-to-cogni/SKILL.md). Rare by design: most work teaches nothing reusable, and that's correct. Not a merge gate — a loop expectation.

## Principles

- **Reuse + reproducibility.** Find existing code (this repo or OSS) that meets your need before writing new. When you do code, code for reuse. For deployments, reproducibility is non-negotiable — no ad-hoc actions; solve each problem once and capture it in git.
- **Search before designing.** `docs/spec/`, `docs/guides/`, `.claude/skills/`, `.claude/commands/`, and the operator API (work items + projects + knowledge) hold prior thinking, designs, and priorities. Refine + simplify + clean what exists rather than add parallel artifacts.
- **Goal-driven execution.** Up front, with the user, identify the before/after I/O that will be clearly testable by a human or an agent. Before closing the work item, you must be able to prove the starting goal is met.
- **Clean architecture.** Hexagonal layering. Strongly-typed boundaries (Zod). Systemic observability (Pino → Loki). Idempotent operations. Strict typing — no `any`.
- **Purge legacy.** Backwards-compat shims are debt unless the user explicitly asks for them.
- **Clarity, conciseness, syntropy.** Code and prose alike — fewer words, sharper meaning, aligned with what already exists. Entropy creeps in through volume.

## Gotchas + Anti-patterns

- Adding backwards-compatibility unless specifically user-instructed. Purge legacy in place.
- Running broad local check/build suites to prove a PR. Avoid `pnpm check`, `pnpm check:fast`, `pnpm packages:build`, and equivalent package/build sweeps unless the user explicitly asks or you are reproducing one named failing check.
- Inline comments narrating _what_ code does, or verbose prose. More text, more entropy — names + types are the docs.
- Ending a turn before `deploy_verified` without an armed `Monitor`/`ScheduleWakeup` on the gating signal (CI, flight, `/version`). Silent end-of-turn = work lost.

## Pointers

- [Development Lifecycle](docs/spec/development-lifecycle.md) · [CI/CD](docs/spec/ci-cd.md) · [Agent-First API Validation](docs/guides/agent-api-validation.md) · [`/validate-candidate`](.claude/skills/validate-candidate/SKILL.md)
- [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md) — registration + executable contributor contract
- [`/contribute-knowledge-to-cogni`](.claude/skills/contribute-knowledge-to-cogni/SKILL.md) — recall + refine the Dolt knowledge hub (the _why_ behind the code; never inline comments or `docs/*.md` sprawl)
- [Architecture](docs/spec/architecture.md) · [Style](docs/spec/style.md) · [Common Mistakes](docs/guides/common-mistakes.md) · [Work Management](work/README.md)
- **Stuck?** File a bug against the operator (above), or read [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md) end-to-end.
