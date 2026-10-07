---
name: contribute-knowledge-to-cogni
description: Umbrella skill for contributing durable knowledge to a Cogni node hub. Triggers when an agent has — or is about to research — context worth compounding for future agents/humans, AND the knowledge is durable enough to survive the syntropy bar. Routes to the right sub-skill by content shape (falsifiable prediction → `edo-loop`; visual for humans → `dolt-human-visuals`; AI-readable text → direct contribution). Use whenever you'd otherwise drop a research finding into a chat log or PR description that should outlive the session. RARE by design — most agent context dies with the session; only what compounds earns an entry.
---

# contribute-knowledge-to-cogni

> The contract lives in the hub, not in this file. This file is the trigger.

## Fetch the contract first

```bash
# $BASE is the node you are contributing to; default https://cognidao.org
curl -fsS -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/knowledge/knowledge-contribution-flow" | jq -r .content
```

That entry is the source of truth for the action hierarchy, the inbox rule, the
four edit ops, and the constraints that 400/409. Read it before writing. Each
node owns its own copy, so fetch from the node you are contributing to.

Then: `cogni-domain-taxonomy` for which shelf, `knowledge-syntropy-protocol`
for whether it earns an entry at all.

## The axioms (hold even if the hub is unreachable)

- **Atoms.** One entry, one claim. A second claim is a second entry that cites the first.
- **Focused.** Most contributable-feeling context is ephemeral. Default to writing nothing.
- **Linked.** A new atom cites a parent or sibling. Zero-edge entries don't compound.
- **Concise, high-signal.** Bold claim line, then structured evidence. Never a prose blob.
- **Refine over add.** Sharpening an existing entry beats filing a new one.

## One inbox per unit of work

An open contribution is an inbox, and **an inbox maps 1:1 to one work item or
one PR** — like a branch.

- Related to your open inbox's work item → append via `POST /contributions/{id}/commits`.
- Unrelated to any open inbox → **open a new one**.
- Many concurrent open inboxes from one principal is **correct**. Sprawl is an
  inbox with unrelated contents; focus is the bar, not count.
- Reuse one saved API key — a fresh agent per write orphans attribution.

## Routing by shape

| shape                                               | go to                                                  |
| --------------------------------------------------- | ------------------------------------------------------ |
| falsifiable prediction resolving in a later session | [`edo-loop`](../edo-loop/SKILL.md)                     |
| genuinely visual artifact (diagram, chart)          | [`dolt-human-visuals`](../dolt-human-visuals/SKILL.md) |
| as-built architecture, contract, invariant          | `docs/spec/*` in the repo, not the hub                 |
| atomic factual claim with provenance                | the contract above                                     |

**A human reviews and merges.** Never merge your own contribution.
