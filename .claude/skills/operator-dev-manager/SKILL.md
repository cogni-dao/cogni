---
name: operator-dev-manager
description: "Top-level router for Cogni's operator node — the AI git-manager that will eventually drive dev across every node in the network. Load this skill for any operator work: PR review automation, candidate-flight tooling, the node-CI/CD contract and node-boundary refinements (dep-cruiser, node-owned packages), observability + dev-agent langgraphs, or anything where 'operator does X across nodes' is the verb. Use proactively when starting an operator task, triaging an operator bug, reviewing an operator PR, debating where a piece of infra lives (operator vs node), or when the work smells operator-adjacent but you don't yet know which queue it belongs to. Also triggers for: 'operator node', 'operator dev manager', 'git review app', 'cogni-git-review', 'pr-manager agent', 'dev agent graph', 'node CI/CD contract', 'node boundary', 'node-owned packages', 'dep-cruiser per node', 'multi-node infra request', 'observability langgraph', 'operator OOM', 'operator wallet', 'operator recover from merge queue cancel', 'task.0409 / 0410 / 0411 / 0413 / 0416 / 0418 / 0419', 'send to cogni error intake', 'why doesn't the operator do X yet'."
---

# Operator Dev Manager

You are the orientation layer for Cogni's **operator** node. This file is intentionally short: it gets you to the right project, spec, or specialty skill — fast.

## What the operator is (one paragraph)

The operator is Cogni's **AI git-manager** — the node that owns the dev loop for the whole multi-node network: triaging work items, reviewing PRs, dispatching candidate-flight, watching deploys, harvesting errors, and (eventually) hand-rolling code via dev-agent langgraphs. Today it is the **most primitive node** in the repo — most of its current code was written by Derek directly, and the only piece autonomously doing real work is the recent VCS layer (`vcs-flight-candidate` + PR ops via `core__vcs_*` tools — see [`git-app-expert`](../git-app-expert/SKILL.md)). It will grow into the **most useful node** because every other node (poly, ai-only, resy, future external repos) inherits its dev management from here. When you work on the operator, treat it as the kernel of multi-node ops, not a generic Next.js app.

## Charter alignment

Anchored to [CHARTER.md](../../../work/charters/CHARTER.md) and [ENGINEERING.md](../../../work/charters/ENGINEERING.md): _"reproducible, open-source foundation for autonomous AI-powered organizations."_ The operator is the executor of that promise — it is what makes "autonomous" non-fictional. Every operator change should make the dev loop measurably more autonomous, more observable, or more portable across nodes. If a change makes the operator more bespoke to one node, push back.

## Top active queues (RIGHT NOW)

Three live workstreams. New operator work usually belongs in one of these — if it doesn't, that's a signal to slow down and re-triage.

### 1. Git Review App

The PR-review side of the operator: `cogni-git-review` GitHub App, pr-manager agent, candidate-flight dispatch, validation loop. This is the **only path currently flighting non-Derek-triggered builds** — protect it.

- Project: [proj.vcs-integration](../../../work/projects/proj.vcs-integration.md) — Active, P1 (auth backend + `services/git-daemon/` absorption of `cogni-git-review`)
- Specialty skill: [`git-app-expert`](../git-app-expert/SKILL.md) — load this for any GH-App / VCS-tool / flight-dispatch work
- Coordinator skill: [`pr-coordinator-v0`](../pr-coordinator-v0/SKILL.md) — single-slot candidate-a flight loop
- Live tasks: [task.0153 PR review bot v0](../../../work/items/task.0153.pr-review-bot-v0.md), [task.0154 PR review deployment finish](../../../work/items/task.0154.pr-review-deployment-finish.md), [task.0409 multi-tenant git-review routing](../../../work/items/task.0409.multi-tenant-git-review-routing.md), [task.0410 reviewer per-node routing](../../../work/items/task.0410.reviewer-per-node-routing.md)
- Memory: [First Operator-Flighted Candidate Build](../../../.claude/projects/-Users-derek-dev-cogni-template/memory/project_first_operator_flight.md), [Codex Executor Missing VCS Tools](../../../.claude/projects/-Users-derek-dev-cogni-template/memory/project_codex_executor_no_vcs_tools.md)

### 2. Node CI/CD Contract + Node-Boundary Refinements

The operator is the **gatekeeper of the node boundary** — what's shared infra vs what each node owns. The contract is [docs/spec/node-ci-cd-contract.md](../../../docs/spec/node-ci-cd-contract.md) and [docs/spec/node-operator-contract.md](../../../docs/spec/node-operator-contract.md). Ongoing tension: nodes need to request services / MCPs / packages without smuggling per-node logic into operator core.

- Spec: [node-ci-cd-contract.md](../../../docs/spec/node-ci-cd-contract.md) — required CI checks per node, manifest discovery, candidate-flight slots
- Spec: [node-operator-contract.md](../../../docs/spec/node-operator-contract.md) — what the operator owns vs what a node owns
- Open boundary work (live, unowned holes — file/triage as you hit them):
  - **Per-node dep-cruiser setups** — each node should govern its own dependency rules; today the operator's rules leak across. Surfaced by [run #25082460609 on PR #1118](https://github.com/Cogni-DAO/node-template/actions/runs/25082460609/job/73490473681?pr=1118).
  - **Node-owned package placement** — where do per-node `packages/<node>-*` packages live, who owns their build/test/publish, how does operator's `pnpm check` see them.
  - **Node-initiated infra requests** — a node wanting a new service / MCP / external integration today has no clean operator-mediated path; usually ends up as a Derek-edited `compose.dev.yaml`.
- Live tasks: [task.0234 node-repo cicd onboarding](../../../work/items/task.0234.node-repo-cicd-onboarding.md), [task.0247 multi-node CICD deployment](../../../work/items/task.0247.multi-node-cicd-deployment.md), [task.0317 per-node graph catalogs](../../../work/items/task.0317.per-node-graph-catalogs.md), [task.0411 split temporal workflows per node](../../../work/items/task.0411.split-temporal-workflows-per-node.md), [task.0413 test-repo as operator-template scaffold](../../../work/items/task.0413.test-repo-as-operator-template-scaffold.md), [task.0414 candidate-flight stub on merge-group](../../../work/items/task.0414.candidate-flight-stub-on-merge-group.md), [task.0415 check:fast turbo DAG](../../../work/items/task.0415.check-fast-turbo-dag.md), [task.0416 operator recover from merge-queue cancel](../../../work/items/task.0416.operator-recover-from-merge-queue-cancel.md)
- Adjacent skills: [`devops-expert`](../devops-expert/SKILL.md), [`deploy-operator`](../deploy-operator/SKILL.md), [`third-party-integrator`](../third-party-integrator/SKILL.md) (for infra-request decisions)

### 3. Observability + Dev-Agent LangGraphs

The operator's **self-awareness layer** — Pino → Loki, agent KPIs, error intake from candidate-a, and the LangGraph-driven dev agents that will eventually act on what they see. Charter ideal: _Cogni AI should be able to monitor its own stats_ and _maximum uptime, no silent outages_.

- Project: [proj.observability-hardening](../../../work/projects/proj.observability-hardening.md) — Paused but tasks are live
- Project: [proj.langgraph-server-production](../../../work/projects/proj.langgraph-server-production.md) — Active, P1 (LangGraph Server prod readiness, billing parity)
- Spec: [observability-requirements.md](../../../docs/spec/observability-requirements.md), [observability.md](../../../docs/spec/observability.md)
- Live tasks: [task.0272 node identity in observability](../../../work/items/task.0272.node-identity-in-observability.md), [task.0308 deployment observability scorecard](../../../work/items/task.0308.deployment-observability-scorecard.md), [task.0418 deploy rollout pod diagnostics](../../../work/items/task.0418.deploy-rollout-pod-diagnostics.md), [task.0419 send-to-cogni error intake v0](../../../work/items/task.0419.send-to-cogni-error-intake-v0.md), [story.0221 agent KPI observability](../../../work/items/story.0221.agent-kpi-observability.md), [bug.0059 operator logs missing root cause](../../../work/items/bug.0059.operator-logs-missing-root-cause.md), [bug.0307 operator OOM candidate-a memory limit](../../../work/items/bug.0307.operator-oom-candidate-a-memory-limit.md)
- Adjacent skills: [`monitoring-expert`](../monitoring-expert/SKILL.md), [`grafana-dashboards`](../grafana-dashboards/SKILL.md), [`engineering-optimizer`](../engineering-optimizer/SKILL.md) (for closing dev-loop feedback gaps)

## Other operator surfaces (lower-frequency but real)

- **Operator wallet / payments** — [proj.ai-operator-wallet](../../../work/projects/proj.ai-operator-wallet.md), [docs/spec/operator-wallet.md](../../../docs/spec/operator-wallet.md), [task.0084](../../../work/items/task.0084.operator-wallet-generation-wiring.md)
- **Loading / error boundaries UX** — [task.0403](../../../work/items/task.0403.operator-loading-error-boundaries.md), [task.0408 port to other nodes](../../../work/items/task.0408.port-loading-error-boundaries-other-nodes.md)
- **Naming / hygiene** — [task.0246 rename web→operator](../../../work/items/task.0246.rename-web-to-operator.md), [bug.0262 operator env-suffix consistency](../../../work/items/bug.0262.operator-env-suffix-consistency.md)
- **Operator Plane (paused)** — [proj.operator-plane](../../../work/projects/proj.operator-plane.md): actor_id as economic primitive, multi-tenant gateway. Gated on a paying gateway customer. Don't pull tasks from here without re-triaging.

## Anti-patterns specific to operator work

- **Smuggling per-node logic into operator core.** If a graph, table, route, or service is poly-specific or resy-specific, it belongs under that node's directory or behind a node-scoped capability — not in operator's `app/`. The whole point of the operator is multi-node uniformity.
- **Treating operator like a generic Next.js app.** It's a kernel for multi-node ops. UX polish PRs are fine but they shouldn't outrun the boundary work — every "make the dashboard prettier" PR is a PR that wasn't "make node X infra-requestable."
- **Adding tools to the 4o-mini path only.** Codex graph executor lacks `core__vcs_*` and `core__repo_open` ([memory](../../../.claude/projects/-Users-derek-dev-cogni-template/memory/project_codex_executor_no_vcs_tools.md)). Tool exposure is backend-scoped — when adding an operator capability, wire it across executors or it's a single-backend toy.
- **Editing node infra in `compose.dev.yaml` and calling it done.** That's the symptom, not the fix — the missing primitive is "node-initiated infra request." File an issue against queue #2 instead of just patching compose.
- **Ignoring the `staging`/`canary` purge.** [bug.0312](../../../work/items/bug.0312.purge-canary-staging-legacy-naming.md), [memory](../../../.claude/projects/-Users-derek-dev-cogni-template/memory/project_canary_dead.md). Operator code should target `main` and `candidate-a` only.

## Cross-cutting enforcement

- **The operator is the holy-clean enforcer.** `main` has no pre-existing failures (CLAUDE.md). When the operator's own check pipeline drifts, the whole network drifts. Treat operator-side `check:fast` / `check` regressions as P0.
- **Every operator feature ends in `deploy_verified` on candidate-a.** Code-gate green is not done. The operator more than any node is the place where _you must drive a real interaction through candidate-a yourself_, because the operator's whole purpose is being the thing that does this for other nodes.
- **`/version.buildSha` must match the source-sha map** for any operator promotion. The operator is the canonical example other nodes copy.

## When in doubt

If the user's request doesn't cleanly fit one of the three live queues above:

1. Re-read [CHARTER.md](../../../work/charters/CHARTER.md) and ask: does this make the dev loop more autonomous, more observable, or more multi-node-portable? If no to all three, push back before writing code.
2. Check [proj.development-workflows](../../../work/projects/proj.development-workflows.md) and [proj.agentic-dev-setup](../../../work/projects/proj.agentic-dev-setup.md) — adjacent operator-flavored projects.
3. If it's about _how_ to drive operator work end-to-end (lifecycle, validation, scorecards, drift), use [`engineering-optimizer`](../engineering-optimizer/SKILL.md) instead of trying to fit the work into a queue prematurely.
