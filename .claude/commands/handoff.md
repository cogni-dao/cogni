It's time to hand this project off to a new developer. Assume they have no context of the task you've been working on, but avoid over-prescribing implementation details. Focus on the mission, goals, functional requirements, validation proof, and pointers to documentation + important files + functions.

Write a handoff to `work/handoffs/{workItemId}.handoff.md` following the contract in `work/README.md#Handoffs` and the template at `work/_templates/handoff.md`.

Rules:

- Max 200 lines, 6 sections, no pasted logs/transcripts
- Link to files/commits instead of copying code blocks > 60 lines
- Frontmatter must include work_item_id, status, branch, last_commit
- Start the body with a **Mission** section. Use "New mission:" only when this is truly new work; otherwise use "Mission:" or "Pickup:" and state what the next developer owns now.
- Follow with a **Goal** section that describes the desired end state and includes the clear E2E validation signal. If deploy behavior is in scope, explicitly say what candidate-a flight proof looks like, including the expected URL, `/version` field, SHA/ref match, workflow, or promoted lane evidence.
- Include a **Start By Reading** section with the minimal docs/specs/files/functions needed to orient quickly.
- Include a **Design / Implementation Target** section with numbered requirements. Keep it outcome-oriented: what must be true, what must not regress, and what boundaries must hold.
- If a handoff already exists, archive the old one to `work/handoffs/archive/{workItemId}/{datetime}.md` first (datetime format: YYYY-MM-DDTHH-MM-SS)
- After writing the handoff, append a link to the work item's `## PR / Links` section: `- Handoff: [handoff](../handoffs/{workItemId}.handoff.md)`

Preferred body shape:

1. **Mission** — one paragraph. "New mission" for fresh work; "Pickup" for existing work.
2. **Goal** — end state + E2E validation. For deploy work, include candidate-a flight proof.
3. **Start By Reading** — bullets with the highest-signal docs/files/functions.
4. **Current State** — facts only: branch, PRs, commits, what is done, what is blocked.
5. **Design / Implementation Target** — numbered requirements and architecture boundaries.
6. **Next Actions / Risks** — checklist plus concise gotchas.

Example tone and structure:

```text
Mission: isolate operator graphs and review node-template spawn/package architecture against the node BaaS north star.

Goal:
Node-template/resy/canary must not inherit operator lifecycle graphs. Operator owns PR Manager, GitHub lifecycle, deploy orchestration, and VCS-backed agent flows. Spawned node repos should have their own node-safe graph bundle at repo root and receive graph/template updates over time via fork/template pulls, not by sharing operator graph catalog discovery.

E2E validation:
Operator can still discover and run PR Manager. node-template/resy/canary cannot discover or route to PR Manager/operator lifecycle graphs. If this work changes deploy behavior, candidate-a proof must show the relevant workflow run, deployed lane URL, and `/version` SHA/ref match.

Start by reading:
- docs/spec/node-baas-architecture.md
- packages/langgraph-graphs/src/catalog.ts
- nodes/operator/app graph/bootstrap wiring
- nodes/node-template/app graph/bootstrap wiring

Design / implementation target:
1. Split graph discovery by runtime.
2. Add tests proving operator graph availability and node runtime graph absence.
3. Keep scope to graph/package isolation.
```

## Final output to the user

End with a fenced block the incoming developer can paste or read cold — no prose summary above it, no decorative headings. The block is the handoff. Include, in this order:

1. **Worktree** — absolute path (`pwd` output).
2. **Branch** — current branch (`git branch --show-current`) and upstream (`git rev-parse --abbrev-ref @{u}` if it exists).
3. **Handoff doc** — path to the file you just wrote.
4. **Immediate next action** — always of the shape: _"Read the handoff + <supporting docs>, then <the first concrete thing to do>, and from there you are in charge."_ The handoff doc is the primary briefing; the next-action line is the bridge from "read the briefing" into "you own this now." Example: _"Read `work/handoffs/task.0331.handoff.md` and `docs/spec/ci-cd.md`, then run `pnpm test:stack:dev tests/stack/poly-mirror.test.ts` against the current branch. From there you're in charge — the task's `## Validation` block is the success criterion."_ If the immediate next action is blocked by something only a human can resolve (missing auth, revoked access, decision the agent cannot make), say what is blocking and who unblocks — do not hand the loop to the next agent only to have them bounce.

This is the high-leverage surface of the handoff — the incoming agent should know where they are, what the primary briefing is, and what to do within the first 10 seconds.

ARGUMENTS: $ARGUMENTS
