---
name: knowledge-syntropy-expert
description: Authoritative planner for Cogni knowledge hubs — Dolt-backed, compounding, agent-first knowledge stores per node, each node growing into a decentralized subject-matter expert for its niche. Use whenever designing, curating, refining, or debugging a hub — adding entries/domains/entry-types, reviewing a contribution, deciding what becomes a knowledge block vs a skill vs code, sequencing roadmap work, choosing UI shape, or arbitrating "more docs vs more code." Holds the syntropy-vs-sprawl line and the refine-over-extend rule.
---

# knowledge-syntropy-expert

> A node is a decentralized AI expert on a niche. Its knowledge hub is the codified mind — skills, guides, references, diagrams, refined and re-refined until the node is _the_ authority on its topic.

## What a knowledge hub is for

Each Cogni node grows into the subject-matter expert for a specific niche community and mission. The knowledge hub is how that expertise compounds — agent skills + AI/human guides + wiki-style references + architectural docs, all in one Dolt-backed store. Most nodes start dolt-only; services arrive when the niche demands them. The cogni monorepo + node-template are the founding building blocks — fork the patterns, fork the hub, grow syntropy independently per niche.

End state: open-core today, optionally privileged/paywalled tomorrow. Agents are first-class consumers. Cross-node federation and x402-gated retrieval are deliberate destinations, not afterthoughts. Every claim is attributable end-to-end — lineage is foundational for cross-node reputation and downstream equity mechanics.

## What makes knowledge valuable

- **Discoverable.** Every entry has a "use when X" framing — same shape as a skill description. If an agent can't decide whether to load it from title + first line, it might as well not exist.
- **Atomic + concise.** One claim per entry, sharpened to the minimum that's still verifiably accurate. Headers, structured tables, diagrams. Prose is the last resort.
- **Cited.** Every claim carries provenance (`source_type`/`source_ref`) and relationships (`citations` edges). Standalone assertions don't compound.
- **Attributable.** Every entry + commit traces to its contributor (principal, source node). Lineage is preserved end-to-end — never anonymized, never overwritten.
- **Visual when human-bound.** Route through [`dolt-human-visuals`](../dolt-human-visuals/SKILL.md) → `entryType: html` per [`docs/spec/knowledge-html-style.md`](../../../docs/spec/knowledge-html-style.md). Text remains correct for AI consumers.
- **Composable.** A high-level guide cites the atomic entries it summarizes — never restates them inline. Recall returns the composite + its leaves with independent confidence scores.

## What makes knowledge degrade

- **Sprawl that breaks discovery.** Three competing entries on the same topic = no entry. The cost isn't storage; it's that the next agent picks the wrong one, or writes a fourth. Compress, deprecate, cite — never duplicate.
- **Bloat by extension.** Lengthening an entry to "cover more cases" makes it less recallable and less verifiable. Edge cases and nuance live in their own atomic entries, joined by citation edges — not in growing paragraphs.
- **High-certainty action on low-confidence rows.** Confidence is load-bearing. `30 = draft` means "starting point, don't bet on it." Agents that act on drafts as if canonical produce drift the system can't recover from.
- **AI-readable artifacts surfaced to humans.** Long slugs, ISO timestamps, always-true columns. Humans don't review what they can't scan; un-reviewed knowledge stays at draft.

## The action hierarchy

When working with the hub, prefer in this order. Each step is preferable to the next:

1. **RECALL** — search the hub. Does it already know this? ([`knowledge-syntropy.md`](../../../docs/spec/knowledge-syntropy.md) recall protocol.)
2. **REFINE** — found a related atom that's slightly off, stale, or bloated? Sharpen it in place. Commit raises confidence and shortens the entry. This is the most valuable move; most knowledge work should look like this.
3. **CITE** — the new claim is a relationship between existing atoms, or an example/edge case of one? Write a `citations` edge, or a new atomic entry that cites the parent. Never inline.
4. **WRITE ATOMIC** — no existing atom covers it. Write a new sharp entry with "use when" framing, then cite anything related.
5. **EXTEND** — anti-pattern. Adding paragraphs to an existing atom to "cover more cases" is bloat. If a refinement doesn't fit, the new content is a sibling atom, not an addendum.

## Decision tree

Walk top-to-bottom. Stop at the first match. Mirrors the action hierarchy.

1. **Does the hub already know this?** Recall first. If yes and the existing atom is sharp — cite it, don't restate.
2. **Is the existing atom muddy, stale, or bloated?** Refine in place — shorten, sharpen, raise confidence. New commit. This is the default move.
3. **Is the new claim a relationship between existing atoms, or an example/edge case?** Write a `citations` edge (`supports` / `contradicts` / `extends` / `supersedes`) or a sibling atom that cites the parent. Never inline "companion to X" prose.
4. **Is this a brand-new atomic claim?** Write a sharp `knowledge` row with `entry_type`, registered `domain`, full provenance, "use when" framing in the title/content.
5. **Is this a composite — guide / playbook / skill spanning multiple atoms?** Write the composite row + outgoing `citations` to its constituents. Composite confidence inherits from leaves; don't fake it.
6. **Missing `entry_type` or `domain`?** Add the entry-type to the syntropy spec (same PR), or register the domain via the registry (not a code change).
7. **Fundamentally new shape — lifecycle, indexes, relationships not modelable as citations?** Propose a new table with a syntropy spec amendment in the same PR.
8. **Need a new `.md` doc under `docs/spec/knowledge-*` or `docs/design/knowledge-*`?** Almost never. Append to an existing section, or — better — write it as a knowledge entry in the hub itself.

If you reach step 8, you're sprawling in git, where humans can't recall it. Knowledge belongs in the hub.

## Non-negotiable invariants

(full list in the specs — these are the ones that get violated)

- **REFINE_OVER_EXTEND** — sharpen atomic entries; never lengthen them. Edge cases get a sibling atom + citation, not a new paragraph. This is the most important syntropy rule.
- **RECALL_BEFORE_WRITE** — search before researching, research before writing. Skipping this is the second-largest entropy source.
- **ATTRIBUTION_TRACEABLE** — every entry + commit traces to its contributor (principal, source node). Lineage is never anonymized, never overwritten. Foundation for cross-node reputation and downstream equity mechanics.
- **ENTRY_HAS_PROVENANCE** + **ENTRY_HAS_DOMAIN** — `source_type`/`source_ref` set, domain registered, or write rejected.
- **DEPRECATE_NOT_DELETE** — superseded rows get `status: deprecated` + a `supersedes` citation edge. History (and the contributor chain) is preserved.
- **SCHEMA_GENERIC_CONTENT_SPECIFIC** — `domain` / `tags` / `entry_type` carry specificity. New tables require justification.
- **DOLT_IS_SOURCE_OF_TRUTH** — Postgres search index is derived and rebuildable.
- **AUTO_COMMIT_ON_WRITE** — every write commits via the capability layer.
- **EXTERNAL_WRITES_TO_BRANCH** — bearer agents → `contrib/*`; only session users merge to `main`.
- **CROSS_LINKS_ARE_EDGES_NOT_COLUMNS** — a relationship between any two entities (knowledge↔knowledge **and** work-item↔knowledge) is a single `citations` row, never a ref-column duplicated on each endpoint (that fractures — the two copies drift). The work-item↔knowledge link generalizes `citations` to allow a work-item endpoint (id-shape `task./bug./…\d+`); it is authored via the contribution `cite` op (so links are curated, validated both-endpoints-exist-on-`main`) and read both directions via the indexed `citing_id`/`cited_id`. Work-item **lifecycle** (claim/status/PR) stays direct-write (autonomy); cross-**links** are curated knowledge. `work_items` holds no link data. Full rationale + roadmap: hub entry `work-knowledge-write-planes` (meta) + work item `story.5017`.

## Anti-sprawl rules

- **One tier in flight at a time.** Roadmap order lives in [`knowledge-syntropy.md` § "Critical Path After v0"](../../../docs/spec/knowledge-syntropy.md). Don't file tier N+1 until N ships.
- **No work-item fan-out.** Capture next steps as prose on the current item, not a fan of follow-up tasks.
- **No parallel docs.** Refine an existing section in place, or write the content as a knowledge entry.
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
