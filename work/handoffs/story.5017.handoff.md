---
id: "story.5017.handoff"
type: handoff
work_item_id: "story.5017"
status: active
created: 2026-06-24
updated: 2026-06-24
branch: "feat/work-item-knowledge-link"
last_commit: "0bb54e6a13"
---

# Handoff: Cross-link work items ↔ knowledge entries

## Mission

Pickup: you own building the **work-item ↔ knowledge cross-link** for the operator. Today the two Doltgres planes can't reference each other — the roadmap can't point at the durable knowledge behind an item, and a knowledge entry can't surface the work tracking it. The only workaround is overloading `specRefs` with knowledge IDs (story.5016), which renders as broken spec links. **The design is fully locked and de-risked (3 review rounds with Derek); your job is the clean implementation.** Do NOT redesign — the column-model was tried and rejected; build the edge model below.

## Goal

- A work-item↔knowledge link is a **single `citations` edge** (the hub's existing one edge table), generalized so one endpoint may be a work-item id. Stored once; read both directions. **No column on `work_items`** (it stays pure coordination); no duplicate on the knowledge entry.
- Links are **curated**: authored via the knowledge contribution `cite` op (inbox), validated that **both endpoints exist on `main`** (knowledge id in knowledge `main`; work id in `work_items` `main`).
- UI: the work-item detail and the knowledge entry detail each render the entity's edges as the small clickable chip; the bespoke `ChainPanel` depth-cards are retired to the same chip.
- **E2E validation (candidate-a, `test.cognidao.org`):** flight the PR head SHA via `POST /api/v1/vcs/flight {nodeRef:{nodeId:"4ff8eac1-4eba-4ed0-931b-b1fe4f64713d", sourceSha}}`, confirm `https://test.cognidao.org/version`.buildSha == head SHA, then: (1) POST a knowledge contribution with a `cite` edge from a real merged knowledge entry to a real `task.*` id → 201; a `cite` to a non-existent work id → rejected; (2) the contribution's knowledge entry page shows the work-item chip, and the work-item detail shows the knowledge chip; (3) EDO chain + `/api/v1/knowledge/graph` still render (no break from work-endpoint edges). Note: candidate-a Dolt is a **separate store** from prod — seed test entities on candidate-a, never assume prod IDs exist there.

## Start By Reading

- `story.5017` work item (`GET /api/v1/work/items/story.5017`) — the **locked FINAL DESIGN + ROADMAP** lives in its summary. Authoritative.
- `.claude/skills/knowledge-syntropy-expert/SKILL.md` → invariant **CROSS_LINKS_ARE_EDGES_NOT_COLUMNS** (the one-line rule).
- `packages/knowledge-base/src/schema.ts` → `citations` table (text endpoints, no FK, `idx_citations_citing`/`_cited`, `uniq_citations_edge`).
- `packages/knowledge-store/src/domain/contribution-schemas.ts` → `KnowledgeContributionEditSchema` (`op:"cite"`) + `ContributionCitationTypeSchema`.
- `packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts` → `insertCitationRow` (~L335), `resolveCitedEntryType` (~L318), cite branch of `applyEdit` (~L453) — **where work-endpoint validation diverges**.
- `packages/knowledge-store/src/adapters/doltgres/edo-resolver.ts` → `recomputeConfidence` (~L166), `walkChain` (~L185, `JOIN knowledge`) — **read sites that drop work nodes**.
- `nodes/operator/app/src/app/api/v1/knowledge/graph/route.ts` (~L100) — drops edges to non-knowledge nodes.
- `nodes/operator/app/src/app/(app)/knowledge/_components/ChainPanel.tsx` — the depth-X UI to clean.
- `docs/guides/cicd-e2e-required-sequence` (hub guide) + skill `validate-candidate`.

## Current State

- Branch `feat/work-item-knowledge-link` reset to latest `main` (`f61544ef03`); only commit is `0bb54e6a13` (skill invariant). PR **#1824 is OPEN but its diff is stale** (the prior column-model was reverted) — repurpose it for the edge model, or close + reopen.
- A prior implementation stored the link as a `work_items.knowledgeRefs` jsonb column + migration `0006`. It **passed CI + validated green on candidate-a** but was **rejected** by Derek (link in 2 tables = fracture; should not be on `work_items`). Fully reverted. Do not resurrect it.
- Generalizing `citations` needs **NO migration** (text endpoints, no FK; discriminate work ids by shape `^(task|bug|spike|story|subtask)\.\d+$`).
- `bug.5059` filed: `playwright-cli state-load` drops the `__Secure-next-auth.session-token` (httpOnly) → `/validate-candidate` human-axis falsely reads as "stale auth". **Workaround:** drive the UI with inline `node` playwright (`browser.newContext({storageState})`) resolving `playwright` from `node_modules/.pnpm/playwright@1.56.1/...`, OR have a human eyeball. curl with the cookie authenticates fine.
- Operator flight uses the legacy lane; candidate-a slot is **shared and gets clobbered** — poll `/version` after flight, re-flight if another build lands.

## Design / Implementation Target

1. **One edge, one table.** The link is a `citations` row. No `work_items` column, no `knowledge.workItemRefs`. (`CROSS_LINKS_ARE_EDGES_NOT_COLUMNS`.)
2. **cite-op accepts a work-item endpoint.** Extend the contribution `cite` edit + adapter so one endpoint may be a `task.*`/`bug.*`/… id. Validate that endpoint against `work_items` `main` (not knowledge). Add a link edge type (e.g. `tracks`/`relates_to`) distinct from the knowledge `supports/extends/...` set.
3. **Validate both-endpoints-on-`main`.** Knowledge endpoint → knowledge `main`; work endpoint → `work_items` `main`. Reject otherwise. (Main-only, by Derek's decision; pending-inbox linking is out of scope — see roadmap R1.)
4. **Do not regress EDO.** `recomputeConfidence`, `walkChain` (`JOIN knowledge`), and `/knowledge/graph` must **skip work endpoints** gracefully — no thrown error, no silent confidence corruption. Hypothesis edges (`derives_from`/`validates`/`invalidates`) stay knowledge-only.
5. **UI = the chip, standardized.** Work-item detail + knowledge detail render edges via `listCitationsBy{Citing,Cited}Id` as the small clickable chip (work→`/work`, knowledge→`/knowledge/{id}`). Retire `ChainPanel` depth-cards to the same chip.
6. **Plane boundary holds.** Work-item lifecycle (claim/status/PR) stays direct-write (autonomy); only the _link_ is curated/inbox-authored.

## Next Actions / Risks

- [ ] Implement Req 2–3 (cite-op + validation) — the keystone; start here.
- [ ] Implement Req 4 read-guards (edo-resolver, graph route) with a test proving a work-endpoint edge doesn't break the chain/graph.
- [ ] Implement Req 5 UI (both detail pages + ChainPanel).
- [ ] Refine hub entry `work-knowledge-write-planes` to the edge model — **blocked:** the PROD knowledge inbox is at the per-principal quota (10/10 open, principal `1bfaa668`); a human must merge/close some first (`bug.5059`-adjacent triage handoff already given to Derek). Until then `POST /contributions` → 429.
- [ ] Ship via `cicd-e2e-required-sequence`; close the loop with `/validate-candidate` (use the inline-playwright workaround for the UI axis).
- Risk: `citations` is **load-bearing** (EDO confidence + chain on prod). The whole risk of this task is Req 4 — write the skip-logic + tests first.
- Risk: id-shape discrimination is the chosen mechanism (no `citingType`/`citedType` columns). If a knowledge entry were ever named `task.NNN` it would misclassify — acceptable now; roadmap R3 migrates to typed columns if ambiguity grows.
- Local hygiene (Derek's machine): never run `pnpm check/test/build`; push `--no-verify`; watch CI with `gh pr checks --watch`.

## Pointers

| File / Resource                                                       | Why it matters                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `story.5017` summary                                                  | Locked design + roadmap (R1 auto-merge pure-cite = the link-autonomy fix)      |
| `contribution-adapter.ts` `insertCitationRow`/`resolveCitedEntryType` | Where work-endpoint validation diverges from knowledge                         |
| `edo-resolver.ts` `walkChain`/`recomputeConfidence`                   | EDO read sites that must skip work nodes (Req 4)                               |
| `knowledge/graph/route.ts`                                            | Graph route drops non-knowledge edges; add work nodes or accept knowledge-only |
| `ChainPanel.tsx`                                                      | Bespoke depth-X cards to retire to chips                                       |
| `listCitationsBy{Citing,Cited}Id` (knowledge-store doltgres adapter)  | Both-direction read for the UI chips                                           |
| `bug.5059`                                                            | playwright-cli auth regression blocking the UI validation axis                 |
