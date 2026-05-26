---
name: knowledge-syntropy-expert
description: Authoritative planner for Cogni knowledge hubs — Dolt-backed, compounding, agent-first knowledge stores per node. Use whenever designing, curating, extending, or debugging a hub — adding entries/domains/entry-types, reviewing a contribution, deciding what becomes a knowledge block vs a skill vs code, sequencing roadmap work, choosing UI shape, or arbitrating "more docs vs more code." Holds the syntropy-vs-sprawl line.
---

# knowledge-syntropy-expert

> A knowledge hub is git for what an organization knows. Skills, guides, wiki references, architectural notes, diagrams — versioned, cited, discoverable, agent-first.

## What a knowledge hub is for

Each Cogni node accumulates its own hub: agent skills + AI/human guides + wiki-style references + architectural docs, all in one Dolt-backed store. Most nodes start dolt-only; services arrive when the niche demands them. The cogni monorepo + node-template are the founding building blocks — fork the patterns, fork the hub, grow syntropy independently per niche.

End state: open-core today, optionally privileged/paywalled tomorrow. Agents are first-class consumers. Cross-node federation and x402-gated retrieval are deliberate destinations, not afterthoughts.

## What makes knowledge valuable

- **Discoverable.** Every entry has a "use when X" framing — same shape as a skill description. If an agent can't decide whether to load it from title + first line, it might as well not exist.
- **Concise.** Headers, structured tables, diagrams. Prose is the last resort.
- **Cited.** Every claim carries provenance (`source_type`/`source_ref`) and relationships (`citations` edges). Standalone assertions don't compound.
- **Visual when human-bound.** Route through [`dolt-human-visuals`](../dolt-human-visuals/SKILL.md) → `entryType: html` per [`docs/spec/knowledge-html-style.md`](../../../docs/spec/knowledge-html-style.md). Text remains correct for AI consumers.
- **Composable.** A high-level guide cites the atomic entries it summarizes. Recall returns the composite + its leaves with independent confidence scores.

## What makes knowledge degrade

- **Sprawl that breaks discovery.** Three competing entries on the same topic = no entry. The cost isn't storage; it's that the next agent picks the wrong one, or writes a fourth. Compress, deprecate, cite — never duplicate.
- **High-certainty action on low-confidence rows.** Confidence is load-bearing. `30 = draft` means "starting point, don't bet on it." Agents that act on drafts as if canonical produce drift the system can't recover from.
- **AI-readable artifacts surfaced to humans.** Long slugs, ISO timestamps, always-true columns. Humans don't review what they can't scan; un-reviewed knowledge stays at draft.

## The syntropy engine: recall before write

Every agent doing knowledge work follows the recall protocol in [`knowledge-syntropy.md`](../../../docs/spec/knowledge-syntropy.md): search the hub before researching externally, before writing a new entry, before acting on a hunch. The first question is _"does the hub already know this?"_ — never _"where do I put it?"_

If recall returns a stale or low-confidence entry, **update it** (new commit, new citations, recomputed confidence) rather than writing a sibling. The citation DAG is what makes confidence compound; siblings break the DAG.

## Decision tree — write, link, compose, or skip

Walk top-to-bottom. Stop at the first match.

1. **Does the hub already know this?** Recall first. If yes — cite + extend, don't restate.
2. **Is this a relationship between existing entries?** Write a `citations` edge (`supports` / `contradicts` / `extends` / `supersedes`). Never inline "companion to X" prose.
3. **Is this a new atomic claim?** Write a `knowledge` row with the right `entry_type`, a registered `domain`, full provenance, and a "use when" framing in the title/content.
4. **Is this a composite — guide / playbook / skill that ties atoms together?** Write the composite row + outgoing `citations` to its constituents. Composite confidence inherits from leaves; don't fake it.
5. **Missing `entry_type` or `domain`?** Add the entry-type to the syntropy spec (same PR), or register the domain via the registry (not a code change).
6. **Fundamentally new shape — lifecycle, indexes, relationships not modelable as citations?** Propose a new table with a syntropy spec amendment in the same PR.
7. **Need a new `.md` doc under `docs/spec/knowledge-*` or `docs/design/knowledge-*`?** Almost never. Append to an existing section, or — better — write it as a knowledge entry in the hub itself.

If you reach step 7, you're sprawling in git, where humans can't recall it. Knowledge belongs in the hub.

## Non-negotiable invariants

(full list in the specs — these are the ones that get violated)

- **RECALL_BEFORE_WRITE** — search before researching, research before writing, write before extending. Skipping is the primary entropy source.
- **DOLT_IS_SOURCE_OF_TRUTH** — Postgres search index is derived and rebuildable.
- **SCHEMA_GENERIC_CONTENT_SPECIFIC** — `domain` / `tags` / `entry_type` carry specificity. New tables require justification.
- **ENTRY_HAS_PROVENANCE** + **ENTRY_HAS_DOMAIN** — `source_type`/`source_ref` set, domain registered, or write rejected.
- **DEPRECATE_NOT_DELETE** — superseded rows get `status: deprecated` + a `supersedes` citation edge.
- **AUTO_COMMIT_ON_WRITE** — every write commits via the capability layer.
- **EXTERNAL_WRITES_TO_BRANCH** — bearer agents → `contrib/*`; only session users merge to `main`.

## Anti-sprawl rules

- **One tier in flight at a time.** Roadmap order lives in [`knowledge-syntropy.md` § "Critical Path After v0"](../../../docs/spec/knowledge-syntropy.md). Don't file tier N+1 until N ships.
- **No work-item fan-out.** Capture next steps as prose on the current item, not a fan of follow-up tasks.
- **No parallel docs.** Extend an existing section, or write the content as a knowledge entry.
- **No backwards-compat shims.** Refactor in place.
- **UI must not leak storage shape.** Slugs, ISO timestamps, always-true columns belong in `<details>` or out entirely. Humans need title + relative time + citation chips.

## Canonical sources

This skill is the synthesis; the docs hold the detail. When they disagree, fix whichever is stale — they should reinforce, not duplicate.

| What                                                | Where                                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live status, scorecard, top-3 asks, active PR stack | [`work/charters/KNOWLEDGE.md`](../../../work/charters/KNOWLEDGE.md)                                                                                                                    |
| Schema, write/read protocols, tier roadmap          | [`docs/spec/knowledge-syntropy.md`](../../../docs/spec/knowledge-syntropy.md)                                                                                                          |
| Infrastructure — Doltgres, per-node DBs, port       | [`docs/spec/knowledge-data-plane.md`](../../../docs/spec/knowledge-data-plane.md)                                                                                                      |
| Branch + contribution flow                          | [`docs/design/knowledge-branch-workflow.md`](../../../docs/design/knowledge-branch-workflow.md), [`knowledge-contribution-api.md`](../../../docs/design/knowledge-contribution-api.md) |
| Human-visual HTML authoring                         | [`dolt-human-visuals`](../dolt-human-visuals/SKILL.md), [`docs/spec/knowledge-html-style.md`](../../../docs/spec/knowledge-html-style.md)                                              |
| Domain registry                                     | [`docs/spec/knowledge-domain-registry.md`](../../../docs/spec/knowledge-domain-registry.md)                                                                                            |
