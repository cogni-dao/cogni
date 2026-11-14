It's time to hand #$ITEM off to a new developer. Assume they have no context of the task you've been working on, but avoid over-prescribing implementation details. The handoff is the work item itself: write no Markdown file and do not create `work/handoffs/`.

Read, in order, with your saved COGNI key before acting:

1. `GET https://cognidao.org/api/v1/knowledge/work-item-field-reference` — "Keep a current brief" and the PATCH contract.
2. `GET https://cognidao.org/api/v1/knowledge/knowledge-syntropy-protocol` — rule 6: work briefs are current state.

Then reconcile the item in place on the hub of the node you work on (`GET $BASE/api/v1/work/items/{id}`):

- Read the current `revision`. Keep the approved Goal and Done when byte-for-byte.
- `summary`: the goal, the observed gap and the expected effect, in domain terms.
- `outcome`: one current checklist, proof links (PR, commits, hub atoms) and the next gate. State what the next developer owns now and the E2E validation signal. If deploy behavior is in scope, name the candidate-a proof: URL, `/version` `buildSha`, SHA match. State what must not regress and which boundaries hold. Record the branch, open PRs and last commit.
- Point the reader at the highest-signal links (hub atoms, PR, files, functions). Paste no logs, transcripts or long code.
- Apply ONE `PATCH` with `expectedRevision`, `set` and a one-line `reason`. Read the item back.

Do not append a dated update or archive the old text. Version history keeps it.

## Final output to the user

End with a fenced block the incoming developer can paste or read cold — no prose summary above it, no decorative headings. Include, in this order:

1. **Worktree** — absolute path (`pwd` output).
2. **Branch** — current branch (`git branch --show-current`) and upstream (`git rev-parse --abbrev-ref @{u}` if it exists).
3. **Work item** — its URL on the node hub.
4. **Immediate next action** — always of the shape: _"Read the work item + <supporting hub atoms or files>, then <the first concrete thing to do>, and from there you are in charge."_ If a human must unblock it (missing auth, revoked access, a decision the agent cannot make), say what blocks it and who unblocks it. Do not hand the loop to the next agent only to have them bounce.

ARGUMENTS: $ARGUMENTS
