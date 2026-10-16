# Fresh-session eval — run by Derek

**Full evals have not run.** Use a fresh Conductor session for each prompt, first on the
original checkout and then on the revised checkout, with the same configured model.
Save the full tool transcript. Judge actual skill reads and hub requests, not announcements.

## 1. Research skips delivery

> Research the cognition changes from the last day or two. Why does every agent open with the same contributor skill announcement? Critically audit the old guidance; do not implement changes.

Follow-up: `What's the smallest fix? Keep this research-only.`

Pass: no contributor Skill/Read call across either turn; relevant cognition/syntropy guidance
is consulted; no code-delivery lifecycle is imposed on the research task.

## 2. Code work enters delivery

> Implement a fix for the cognition startup bug: research-only sessions should not be sent through the code-delivery lifecycle. Scope is approved for one PR on this node. Start the normal implementation workflow and identify the first concrete changes.

Follow-up: `Continue the existing contribution. Reuse its node, credentials, and work item.`

Pass: contributor skill loads; existing identity/item is reused; the node's live shipping
guide is recalled; CI, operator flight, feature-specific candidate validation, operator
merge, and promotion gates survive. Do not claim a completed delivery from startup alone.
If the checkout already fixes the issue, report that fact and inspect the workflow selected.

## 3. Curation enters knowledge flow

> Audit our hub for duplicated constitution text and stale .md references. Use the knowledge syntropy steward and md-to-hub migration guidance to identify the canonical existing entry and propose an in-place cleanup. This is knowledge curation, not a code change.

Follow-up: `Show the existing canonical entry and the exact refinement; don't create a duplicate.`

Pass: syntropy loads; the node's knowledge index, migration design, and contribution flow
are actually recalled; existing entries are preferred; contributor/code delivery stays idle.

## Supplemental cases and limits

`routing.json` also covers architecture Q&A, resumed PR delivery, knowledge-only contribution,
and Poly-node ownership. Its original historical counterexample remains in `evals.json`.

Local `.context/cognition-routing-evals/` preserves before/after guidance snapshots and a
supplemental native CLI routing-only runner. That runner disables hooks, network tools,
and writes: it cannot prove hub recall, full startup, implementation, or live delivery.
Its single setup attempt failed before any model call; there are no completed scores.
Use the existing skill-creator grading schema and viewer for the actual captured runs;
report incomplete runs as incomplete, and compare models before interpreting results.
